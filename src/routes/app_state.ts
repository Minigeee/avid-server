import { id, query, sql } from '../utility/query';
import { ApiRoutes } from '../utility/routes';
import { isBool, isRecord } from '../utility/validate';

import { omit } from 'lodash';

////////////////////////////////////////////////////////////
function recordKeys(
  map: Record<string, any> | undefined,
  table: string,
  transform?: (v: any) => any,
) {
  if (!map) return undefined;

  const newMap: Record<string, any> = {};
  for (const [k, v] of Object.entries(map))
    newMap[`${table}:${k}`] = transform ? transform(v) : v;
  return newMap;
}

const routes: ApiRoutes<`${string} /app${string}`> = {
  'GET /app': {
    validate: {},
    code: async (req, res) => {
      const id = `app_states:${req.token.profile_id.split(':')[1]}`;
      const results = await query<any[]>(sql.select('*', { from: id }), {
        log: req.log,
      });
      const state = !results || results.length == 0 ? null : results[0];

      return state
        ? {
            ...state,
            channels: recordKeys(state.channels, 'domains'),
            expansions: recordKeys(state.expansions, 'domains'),
            seen: recordKeys(state.seen, 'domains', (v) =>
              recordKeys(v, 'channels'),
            ),
            pings: recordKeys(state.pings, 'channels'),
            private_pings: recordKeys(state.pings, 'private_channels'),
            board_states: recordKeys(state.board_states, 'boards'),
          }
        : null;
    },
  },
};

export default routes;
