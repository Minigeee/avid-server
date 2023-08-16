import { id, query, sql } from '../utility/query';
import { ApiRoutes } from '../utility/routes';
import { isBool, isRecord } from '../utility/validate';

import { omit } from 'lodash';


////////////////////////////////////////////////////////////
function transformObject(value: any, transform: (k: string, v: any) => [string, any]) {
	if (typeof value !== 'object')
		throw new Error(`must be an object`);

	for (const [k, v] of Object.entries(value)) {
		try {
			const entry = transform(k, v);
			if (k !== entry[0]) {
				delete value[k];
				value[entry[0]] = entry[1];
			}
			else if (v !== entry[1])
				value[k] = entry[1];
		}
		catch (err: any) {
			throw new Error(`[${k}] ${err.message}`);
		}
	}

	return value;
}

////////////////////////////////////////////////////////////
function recordKeys(map: Record<string, any> | undefined, table: string, transform?: (v: any) => any) {
	if (!map) return undefined;

	const newMap: Record<string, any> = {};
	for (const [k, v] of Object.entries(map))
		newMap[`${table}:${k}`] = transform ? transform(v) : v;
	return newMap;
}


const routes: ApiRoutes<`${string} /app${string}`> = {
	"GET /app": {
		validate: { },
		code: async (req, res) => {
			const id = `app_states:${req.token.profile_id.split(':')[1]}`;
			const results = await query<any[]>(sql.select('*', { from: id }), { log: req.log });
			const state = !results || results.length == 0 ? null : results[0];

			return state ? {
				...state,
				channels: recordKeys(state.channels, 'domains'),
				expansions: recordKeys(state.expansions, 'domains'),
				seen: recordKeys(state.seen, 'domains', (v) => recordKeys(v, 'channels')),
				pings: recordKeys(state.pings, 'channels'),
			} : null;
		},
	},

	"POST /app": {
		validate: {
			domain: {
				required: false,
				location: 'body',
			},
			channels: {
				required: false,
				location: 'body',
				transform: (value) => transformObject(value, (k, v) => ([id(k), isRecord(v, 'channels')])),
			},
			expansions: {
				required: false,
				location: 'body',
				transform: (value) => transformObject(value, (k, v) => ([id(k), v])),
			},
			last_accessed: {
				required: false,
				location: 'body',
				transform: (value) => transformObject(value, (k, v) => ([
					id(k),
					transformObject(v, (k, v) => ([id(k), isBool(v)]))
				])),
			},
			pings: {
				required: false,
				location: 'body',
				transform: (value) => transformObject(value, (k, v) => ([id(k), v])),
			},
			right_panel_opened: {
				required: false,
				location: 'body',
				transform: isBool,
			},
			_merge: {
				required: false,
				location: 'body',
				transform: isBool,
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