import assert from 'assert';

import { ApiPath, ApiRouteOptions, ApiSchema } from '@app/types';
import wrapper from './wrapper';
import { StatusError } from './error';

import {
  Express,
  NextFunction,
  Request,
  RequestHandler,
  Response,
  Router,
} from 'express';
import { query } from './query';

/** Request object for a certain api path */
export type ApiRequest<Path extends ApiPath> = Request<
  ApiSchema[Path] extends { params: string[] }
    ? Record<ApiSchema[Path]['params'][number], string>
    : {},
  any,
  ApiSchema[Path] extends { body: any } ? ApiSchema[Path]['body'] : {},
  ApiSchema[Path] extends { query: any } ? ApiSchema[Path]['query'] : {}
> &
  (ApiSchema[Path] extends { req: any } ? ApiSchema[Path]['req'] : {});

/** Request handler for a certain api path */
export type ApiRequestHandler<Path extends ApiPath> = (
  req: ApiRequest<Path>,
  res: Response,
  next: NextFunction,
) => Promise<void> | void;

/** Helper function for transform map */
type _Validate<T, Loc extends string, Path extends ApiPath> = {
  [K in keyof T]-?: {
    /** Determines if this option is required */
    required: undefined extends T[K] ? false : true;
    /** The location of the parameter */
    location: Loc;
    /** The trnasformer function that validates data and returns the option's useable form. If the data is not valid, an error should be thrown with the error message */
    transform?: (value: any, req: ApiRequest<Path>) => Exclude<T[K], undefined>;
  } | null;
};

/** Route definition for a single route */
export type ApiRouteDefinition<Path extends ApiPath = ApiPath> = {
  /** A map of route option transformers/validators */
  validate: (ApiSchema[Path] extends { params: string[] }
    ? _Validate<
        Record<ApiSchema[Path]['params'][number], string>,
        'params',
        Path
      >
    : {}) &
    (ApiSchema[Path] extends { query: any }
      ? _Validate<ApiSchema[Path]['query'], 'query', Path>
      : {}) &
    (ApiSchema[Path] extends { body: any }
      ? _Validate<ApiSchema[Path]['body'], 'body', Path>
      : {});
  /** A function that creates the db query that should be performed to check if the user has permission to perform this request */
  permissions?: (req: ApiRequest<Path>) => string;
  /** The code that should be run at the very end. It is responsible for all the logic of this api route, as well as filtering and returning the data to the user. The route return data should be returned from this function. */
  code: (
    req: ApiRequest<Path>,
    res: Response,
  ) => Promise<
    ApiSchema[Path] extends { return: any } ? ApiSchema[Path]['return'] : void
  >;
  /** Extra middlewares */
  middleware?: {
    /** The location in the chain the middleware should be executed */
    before: 'transforms' | 'permissions' | 'end';
    /** The middleware handler */
    handler: ApiRequestHandler<Path>;
    /** Specify if a wrapper should be used (default true) */
    wrapper?: boolean;
  }[];
};

/** A map of route definitions */
export type ApiRoutes<Match extends string> = {
  [K in ApiPath as K extends Match ? K : never]: ApiRouteDefinition<K>;
};

/**
 * Create route handlers based on a route definition
 *
 * @param def The route definition
 * @returns A list of route handlers
 */
function createHandlers(def: ApiRouteDefinition<'GET /messages'>) {
  const handlers: RequestHandler[] = [];

  // Middlewares
  const preTransforms = def.middleware?.filter(
    (x) => x.before === 'transforms',
  );
  const prePermissions = def.middleware?.filter(
    (x) => x.before === 'permissions',
  );
  const preEnd = def.middleware?.filter((x) => x.before === 'end');

  // Pre-validators
  if (preTransforms?.length)
    handlers.push(
      ...preTransforms.map((x) =>
        x.wrapper === false
          ? (x.handler as any)
          : wrapper.api(x.handler as any),
      ),
    );

  // Validators
  handlers.push((req, res, next) => {
    const errors: { name: string; opts: { location: string }; msg: string }[] =
      [];

    // Validate all options
    for (const [name, opts] of Object.entries(def.validate)) {
      // Skip if no validators
      if (!opts) continue;

      // Get value
      const value = req[opts.location][name];
      if (value === undefined) {
        if (opts.required)
          errors.push({ name, opts, msg: 'is a required parameter' });

        continue;
      }

      // Perform validation/transform
      try {
        const newData = opts.transform?.(value, req as any);
        if (newData !== undefined) req[opts.location][name] = newData as any;
      } catch (err: any) {
        errors.push({ name, opts, msg: err.message });
      }
    }

    if (errors.length > 0) {
      throw new StatusError(
        errors
          .map((x) => `"${x.opts.location}.${x.name}" ${x.msg}`)
          .join(' | '),
        { status: 400 },
      );
    } else next();
  });

  // Pre-permissions
  if (prePermissions?.length)
    handlers.push(
      ...prePermissions.map((x) =>
        x.wrapper === false
          ? (x.handler as any)
          : wrapper.api(x.handler as any),
      ),
    );

  // Permissions
  if (def.permissions) {
    handlers.push(
      wrapper.api(async (req, res) => {
        assert(def.permissions);

        // Check if requester has permission
        const hasPermission = await query<boolean>(
          def.permissions(req as any),
          { log: req.log },
        );
        if (!hasPermission)
          throw new StatusError(
            'you do not have permission to use this route',
            { status: 403 },
          );
      }),
    );
  }

  // Pre-end
  if (preEnd?.length)
    handlers.push(
      ...preEnd.map((x) =>
        x.wrapper === false
          ? (x.handler as any)
          : wrapper.api(x.handler as any),
      ),
    );

  // End
  handlers.push(
    wrapper.api(async (req, res) => {
      const results = await def.code(req as any, res);
      results ? res.json(results) : res.send();
    }),
  );

  return handlers;
}

/**
 * Create routes from a route definition map
 *
 * @param app The express app to add routes to
 * @param routes The map of routes to create
 */
export function createRoutes(app: Express, routes: ApiRoutes<ApiPath>) {
  // Grouped route definitions
  const grouped: Record<
    string,
    Record<
      string,
      {
        get?: ApiRouteDefinition;
        post?: ApiRouteDefinition;
        put?: ApiRouteDefinition;
        patch?: ApiRouteDefinition;
        delete?: ApiRouteDefinition;
      }
    >
  > = {};

  // Group route defs
  for (const [route, def] of Object.entries(routes)) {
    // Get route
    let [method, path] = route.split(' ');
    method = method.toLowerCase();
    assert(
      method === 'get' ||
        method === 'post' ||
        method === 'put' ||
        method === 'patch' ||
        method === 'delete',
    );

    // Get router category
    const pathParts = path.split('/');
    const router = pathParts[1];
    path = '/' + pathParts.slice(2).join('/');

    // Create groups
    if (!grouped[router]) grouped[router] = {};
    if (!grouped[router][path]) grouped[router][path] = {};

    // Set route def (method as get so typescript wont complain)
    // @ts-ignore
    grouped[router][path][method] = def;
  }

  // Create routers
  for (const [routerName, paths] of Object.entries(grouped)) {
    const router = Router();

    // Add paths to router
    for (const [path, methods] of Object.entries(paths)) {
      const route = router.route(path);
      // console.log(routerName, path, Object.keys(methods));

      // Create route handlers
      if (methods.get) route.get(createHandlers(methods.get as any));
      if (methods.post) route.post(createHandlers(methods.post as any));
      if (methods.put) route.put(createHandlers(methods.put as any));
      if (methods.patch) route.patch(createHandlers(methods.patch as any));
      if (methods.delete) route.delete(createHandlers(methods.delete as any));
    }

    // Use router
    app.use('/' + routerName, router);
  }
}
