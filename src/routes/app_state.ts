import { query, sql } from '../utility/query';
import { ApiRoutes } from '../utility/routes';

import { omit } from 'lodash';


const routes: ApiRoutes<`${string} /app${string}`> = {
	"GET /app": {
		validate: { },
		code: async (req, res) => {
			const id = `app_states:${req.token.profile_id.split(':')[1]}`;
			const results = await query<any[]>(sql.select('*', { from: id }), { log: req.log });

			return !results || results.length == 0 ? null : results[0];
		},
	},

	"POST /app": {
		validate: {
			_merge: {
				required: false,
				location: 'body',
				transform: (value) => {
					if (typeof value !== 'boolean')
						throw new Error('must be a boolean');
					return value;
				}
			},
		},
		code: async (req, res) => {
			const id = `app_states:${req.token.profile_id.split(':')[1]}`;
			await query<any[]>(sql.update(id, {
				content: omit(req.body, '_merge'),
				merge: req.body._merge || true,
			}), { log: req.log });
		},
	},
};

export default routes;