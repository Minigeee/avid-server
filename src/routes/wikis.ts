import assert from 'assert';

import { Reaction, Wiki } from '@app/types';
import { emitBatchEvent } from '../utility/batcher';
import { hasPermission, isPrivateMember, query, sql } from '../utility/query';
import { ApiRoutes } from '../utility/routes';
import { asBool, asRecord, isBool, isRecord, sanitizeHtml } from '../utility/validate';
import { getChannel } from '../utility/db';
import { io } from '../sockets';

// WIP : Make routes
const routes: ApiRoutes<`${string} /wikis${string}`> = {
  'GET /wikis/:wiki_id': {
    validate: {
      wiki_id: {
        required: true,
        location: 'params',
        transform: (value) => asRecord('wikis', value),
      },
      draft: {
        required: false,
        location: 'query',
        transform: asBool,
      },
    },
    permissions: (req) => {
      const channel_id = `channels:${req.params.wiki_id.split(':')[1]}`;
      return sql.return(
        hasPermission(
          req.token.profile_id,
          channel_id,
          req.query.draft ? 'can_edit_document' : 'can_view',
        ),
      );
    },
    code: async (req, res) => {
      // Get wiki
      const result = await query<Wiki>(
        sql.select<Wiki>(
          ['id', 'content', req.query.draft ? 'draft' : undefined],
          {
            from: req.params.wiki_id,
            single: true,
          },
        ),
        { log: req.log }
      );
      assert(result);

      return result;
    },
  },

  'PATCH /wikis/:wiki_id': {
    validate: {
      wiki_id: {
        required: true,
        location: 'params',
        transform: (value) => asRecord('wikis', value),
      },
      content: {
        required: false,
        location: 'body',
        transform: sanitizeHtml,
      },
      draft: {
        required: false,
        location: 'body',
        transform: sanitizeHtml,
      },
    },
    permissions: (req) =>
      sql.return(
        hasPermission(
          req.token.profile_id,
          `channels:${req.params.wiki_id.split(':')[1]}`,
          'can_edit_document',
        ),
      ),
    code: async (req, res) => {
      const result = await query<Wiki>(
        sql.update<Wiki>(req.params.wiki_id, {
          set: {
            content: req.body.content,
            draft: req.body.content ? null : req.body.draft,
          },
          single: true,
        }),
        { log: req.log }
      );
      assert(result);

      return result;
    },
  },
};

export default routes;
