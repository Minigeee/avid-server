import assert from 'assert';

import { Board, ExpandedMember, Member, Task, Thread } from '@app/types';

import config from '../config';
import { hasPermission, query, sql } from '../utility/query';
import { ApiRoutes } from '../utility/routes';
import { asInt, asRecord, isArray, isRecord, sanitizeHtml } from '../utility/validate';
import { MEMBER_SELECT_FIELDS } from './members';

import { isNil, pick, omitBy } from 'lodash';


const routes: ApiRoutes<`${string} /threads${string}`> = {
	"GET /threads": {
		validate: {
			channel: {
				required: true,
				location: 'query',
				transform: (value) => asRecord('channels', value),
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
		},
		permissions: (req) => sql.return(hasPermission(req.token.profile_id, req.query.channel, 'can_view')),
		code: async (req, res) => {
			const limit = Math.min(req.query.limit || config.db.page_size.threads, 1000);

			// Perform query
			const results = await query<Thread[]>(
				sql.select<Thread>('*', {
					from: 'threads',
					where: sql.match<Thread>({ channel: req.query.channel }),
					start: req.query.page !== undefined ? req.query.page * limit : undefined,
					limit: limit,
					sort: [{ field: 'last_active', order: 'DESC' }],
				}),
				{ log: req.log }
			);
			assert(results);

			return results;
		},
	},

	"PATCH /threads/:thread_id": {
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
		},
		permissions: (req) => sql.return(`${req.params.thread_id}.starters CONTAINS ${req.token.profile_id} || ${hasPermission(req.token.profile_id, `${req.params.thread_id}.channel`, 'can_manage')}`),
		code: async (req, res) => {
			// Perform query
			const results = await query<Thread[]>(
				sql.update<Thread>(req.params.thread_id, {
					set: {
						name: req.body.name,
					},
				}),
				{ log: req.log }
			);
			assert(results);

			return results[0];
		},
	},
};

export default routes;