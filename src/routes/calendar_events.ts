import assert from 'assert';

import { Board, CalendarEvent, ExpandedMember, Member, Task } from '@app/types';

import config from '../config';
import { emitChannelEvent } from '../sockets';
import { SqlMatchConditions, hasPermission, query, sql } from '../utility/query';
import { ApiRoutes } from '../utility/routes';
import { asDate, asRecord, isArray, isDate, isRecord, sanitizeHtml } from '../utility/validate';
import { MEMBER_SELECT_FIELDS } from './members';

import { isNil, pick, omitBy } from 'lodash';


/** Picks event fields from api object */
function pickEvent(value: any) {
	return pick<CalendarEvent>(value, [
		'all_day',
		'channel',
		'color',
		'description',
		'end',
		'start',
		'title',
	] as (keyof CalendarEvent)[]);
}

const routes: ApiRoutes<`${string} /calendar_events${string}`> = {
	"GET /calendar_events": {
		validate: {
			channel: {
				location: 'query',
				required: true,
				transform: (value) => asRecord('channels', value),
			},
			from: {
				location: 'query',
				required: false,
				transform: asDate,
			},
			to: {
				location: 'query',
				required: false,
				transform: asDate,
			},
		},
		permissions: (req) => sql.return(hasPermission(req.token.profile_id, req.query.channel, 'can_view')),
		code: async (req, res) => {
			// Set up match conditions
			const match: SqlMatchConditions<CalendarEvent> = {
				channel: req.query.channel,
			};

			if (req.query.from)
				match.end = ['>', req.query.from.toISOString()];
			if (req.query.to)
				match.start = ['<', req.query.to.toISOString()];

			// Perform query
			const results = await query<CalendarEvent[]>(
				sql.select<CalendarEvent>([
					'all_day',
					'channel',
					'color',
					'end',
					'id',
					'start',
					'time_created',
					'title',
				], {
					from: 'calendar_events',
					where: sql.match(match)
				}),
				{ log: req.log }
			);
			assert(results);

			return results;
		},
	},

	"POST /calendar_events": {
		validate: {
			all_day: {
				location: 'body',
				required: false,
			},
			channel: {
				location: 'body',
				required: true,
				transform: (value) => isRecord(value, 'channels'),
			},
			color: {
				location: 'body',
				required: false,
			},
			description: {
				location: 'body',
				required: false,
				transform: sanitizeHtml,
			},
			end: {
				location: 'body',
				required: false,
				transform: isDate,
			},
			start: {
				location: 'body',
				required: true,
				transform: isDate,
			},
			title: {
				location: 'body',
				required: true,
			},
		},
		permissions: (req) => sql.return(hasPermission(req.token.profile_id, req.body.channel, 'can_manage_events')),
		code: async (req, res) => {
			// Pick calendar event fields
			const event = pickEvent(req.body);

			// Create event
			const results = await query<CalendarEvent[]>(
				sql.create<CalendarEvent>('calendar_events', {
					...event,
					end: req.body.end || req.body.start,
				}),
				{ log: req.log }
			);
			assert(results && results.length > 0);
			
			// Notify that calendar changed
			const channel_id = req.body.channel;
			emitChannelEvent(channel_id, (room) => {
				room.emit('calendar:activity', channel_id);
			}, { profile_id: req.token.profile_id });

			return results[0];
		},
	},

	"GET /calendar_events/:event_id": {
		validate: {
			event_id: {
				location: 'params',
				required: true,
				transform: (value) => asRecord('calendar_events', value),
			},
		},
		permissions: (req) => sql.return(hasPermission(req.token.profile_id, `${req.params.event_id}.channel`, 'can_view')),
		code: async (req, res) => {
			// Get calendar event
			const results = await query<CalendarEvent[]>(
				sql.select<CalendarEvent>('*', { from: req.params.event_id }),
				{ log: req.log }
			);
			assert(results);

			return results.length > 0 ? results[0] : null;
		},
	},

	"PATCH /calendar_events/:event_id": {
		validate: {
			all_day: {
				location: 'body',
				required: false,
			},
			color: {
				location: 'body',
				required: false,
			},
			description: {
				location: 'body',
				required: false,
				transform: sanitizeHtml,
			},
			end: {
				location: 'body',
				required: false,
				transform: isDate,
			},
			event_id: {
				location: 'params',
				required: true,
				transform: (value) => asRecord('calendar_events', value),
			},
			start: {
				location: 'body',
				required: false,
				transform: isDate,
			},
			title: {
				location: 'body',
				required: false,
			},
		},
		permissions: (req) => sql.return(hasPermission(req.token.profile_id, `${req.params.event_id}.channel`, 'can_manage_events')),
		code: async (req, res) => {
			// Pick calendar event fields
			const event = pickEvent(req.body);
			if (event.channel)
				delete event.channel;

			// Update event
			const results = await query<CalendarEvent[]>(
				sql.update<CalendarEvent>(req.params.event_id, {
					content: event,
				}),
				{ log: req.log }
			);
			assert(results && results.length > 0);
			
			// Notify that calendar changed
			const channel_id = results[0].channel;
			emitChannelEvent(channel_id, (room) => {
				room.emit('calendar:activity', channel_id);
			}, { profile_id: req.token.profile_id });

			return results[0];
		},
	},

	"DELETE /calendar_events/:event_id": {
		validate: {
			event_id: {
				location: 'params',
				required: true,
				transform: (value) => asRecord('calendar_events', value),
			},
		},
		permissions: (req) => sql.return(hasPermission(req.token.profile_id, `${req.params.event_id}.channel`, 'can_manage_events')),
		code: async (req, res) => {
			// Delete event
			const results = await query<CalendarEvent[]>(
				sql.delete(req.params.event_id, { return: 'BEFORE' }),
				{ log: req.log }
			);
			assert(results);

			// Notify that calendar changed
			if (results.length > 0) {
				const channel_id = results[0].channel;
				emitChannelEvent(channel_id, (room) => {
					room.emit('calendar:activity', channel_id);
				}, { profile_id: req.token.profile_id });
			}
		},
	},
};

export default routes;