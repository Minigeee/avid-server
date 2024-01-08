import assert from 'assert';

import { Thread } from '@app/types';

import config from '../config';
import { hasPermission, isPrivateMember, query, sql } from '../utility/query';
import { ApiRoutes } from '../utility/routes';
import {
  asArray,
  asBool,
  asInt,
  asRecord,
  isArray,
  isBool,
  isRecord,
  sanitizeHtml,
} from '../utility/validate';

const routes: ApiRoutes<`${string} /threads${string}`> = {
  'GET /threads': {
    validate: {
      channel: {
        required: true,
        location: 'query',
        transform: (value, req) =>
          typeof req.query.private === 'string' && req.query.private === 'true'
            ? asRecord('private_channels', value)
            : asRecord('channels', value),
      },
      ids: {
        required: false,
        location: 'query',
        transform: (value) =>
          asArray(value, (value) => asRecord('threads', value), {
            maxlen: 1000,
          }),
      },
      page: {
        required: false,
        location: 'query',
        transform: (value) => asInt(value, { min: 0 }),
      },
      limit: {
        required: false,
        location: 'query',
        transform: (value) => asInt(value, { min: 1 }),
      },
      private: {
        required: false,
        location: 'query',
        transform: asBool,
      },
    },
    permissions: (req) => {
      const conds = [
        req.query.private
          ? isPrivateMember(req.token.profile_id, req.query.channel)
          : hasPermission(req.token.profile_id, req.query.channel, 'can_view'),
      ];
      if (req.query.ids)
        conds.push(
          `array::all((SELECT VALUE channel == ${
            req.query.channel
          } FROM [${req.query.ids.join(',')}]))`,
        );

      return sql.return(conds.join('&&'));
    },
    code: async (req, res) => {
      const limit = Math.min(
        req.query.limit || config.db.page_size.threads,
        1000,
      );

      // Match conditions
      const match: any = { channel: req.query.channel };
      if (req.query.ids) match.id = ['IN', req.query.ids];

      // Perform query
      const results = await query<Thread[]>(
        sql.select<Thread>('*', {
          from: 'threads',
          where: sql.match<Thread>(match),
          start:
            req.query.page !== undefined ? req.query.page * limit : undefined,
          limit: limit,
          sort: [{ field: 'last_active', order: 'DESC' }],
        }),
        { log: req.log },
      );
      assert(results);

      return results;
    },
  },

  'PATCH /threads/:thread_id': {
    validate: {
      thread_id: {
        required: true,
        location: 'params',
        transform: (value) => asRecord('threads', value),
      },
      name: {
        required: true,
        location: 'body',
      },
      private: {
        required: false,
        location: 'body',
        transform: isBool,
      },
    },
    permissions: (req) =>
      sql.return(
        `${req.params.thread_id}.starters CONTAINS ${req.token.profile_id} || ${
          req.body.private
            ? isPrivateMember(
                req.token.profile_id,
                `${req.params.thread_id}.channel`,
              )
            : hasPermission(
                req.token.profile_id,
                `${req.params.thread_id}.channel`,
                'can_manage',
              )
        }`,
      ),
    code: async (req, res) => {
      // Perform query
      const results = await query<Thread[]>(
        sql.update<Thread>(req.params.thread_id, {
          set: {
            name: req.body.name,
          },
        }),
        { log: req.log },
      );
      assert(results);

      return results[0];
    },
  },
};

export default routes;
