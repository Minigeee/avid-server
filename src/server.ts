// Load environment variables
import dotenv from 'dotenv';
dotenv.config();

import { createServer as createHttpServer, Server as HttpServer } from 'http';

import { AccessToken } from '@app/types';
import config from './config';
import { Logger } from './logs';
import { makeSocketServer } from './sockets';
import { db } from './utility/db';
import { createRoutes } from './utility/routes';
import { getSessionUser } from './utility/auth';
import { errorHandler, StatusError } from './utility/error';

import cors from 'cors';
import express, { Express, Request, Response, NextFunction } from 'express';

////////////////////////////////////////////////////////////
declare global {
  namespace Express {
    interface Request {
      token: AccessToken;
    }
  }
}

/** HTTP server used to host both REST API and websockets connections */
let _httpServer: HttpServer;
/** Express app */
let _expressApp: Express;

///////////////////////////////////////////////////////////
async function makeExpressServer() {
  _expressApp = express();
  _httpServer = createHttpServer(_expressApp);

  // Enable cors
  _expressApp.use(cors({ credentials: true }));

  // Parse json bodies
  _expressApp.use(express.json({ limit: '5mb' }));

  // Authentication
  _expressApp.use((req: Request, res: Response, next: NextFunction) => {
    // Parse auth headers to get identity
    const token = req.headers.authorization?.split(' ')?.[1];
    const tokenObj = getSessionUser(token);

    if (!tokenObj?.profile_id) {
      next(new StatusError('not authenticated', { status: 401 }));
    } else {
      req.token = tokenObj;
      next();
    }
  });

  // Attach logger
  _expressApp.use((req: Request, res: Response, next: NextFunction) => {
    // Add logger
    req.log = new Logger({ req });

    // Log to indicate that this route was requested
    req.log.verbose('start');

    next();
  });

  // Create routes
  createRoutes(_expressApp, {
    ...require('./routes/app_state').default,
    ...require('./routes/boards').default,
    ...require('./routes/calendar_events').default,
    ...require('./routes/channel_groups').default,
    ...require('./routes/channels').default,
    ...require('./routes/domains').default,
    ...require('./routes/members').default,
    ...require('./routes/messages').default,
    ...require('./routes/permissions').default,
    ...require('./routes/profiles').default,
    ...require('./routes/reactions').default,
    ...require('./routes/roles').default,
    ...require('./routes/tasks').default,
    ...require('./routes/threads').default,
  });

  // Error handler
  _expressApp.use(errorHandler);

  // Launch express app
  const port = process.env.PORT || 3001;
  _httpServer.listen(port, () =>
    console.log(`Backend server running on port ${port}`),
  );
}

///////////////////////////////////////////////////////////
async function main() {
  // Sign in to db
  // @ts-ignore
  await db.signin({
    user: config.db.username,
    pass: config.db.password,
    // @ts-ignore
    NS: config.dev_mode ? undefined : config.db.namespace,
  });
  await db.use({
    ns: config.db.namespace,
    db: config.db.database,
  });

  // Create express (and http) server
  await makeExpressServer();

  // Create socket.io server
  await makeSocketServer(_httpServer);
}

main();
