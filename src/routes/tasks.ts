import assert from 'assert';

import { Board, ExpandedMember, Member, Task } from '@app/types';

import config from '../config';
import { emitChannelEvent } from '../sockets';
import { hasPermission, query, sql } from '../utility/query';
import { ApiRoutes } from '../utility/routes';
import { asRecord, isArray, isRecord, sanitizeHtml } from '../utility/validate';
import { MEMBER_SELECT_FIELDS } from './members';

import { isNil, pick, omitBy } from 'lodash';


/** Picks task fields from api object */
function pickTask(value: any) {
	return pick<Task>(value, [
		'assignee',
		'collection',
		'dependencies',
		'description',
		'due_date',
		'priority',
		'status',
		'subtasks',
		'summary',
		'tags',
	] as (keyof Task)[]);
}

const routes: ApiRoutes<`${string} /tasks${string}`> = {
	"GET /tasks": {
		validate: {
			board: {
				required: true,
				location: 'query',
				transform: (value) => asRecord('boards', value),
			},
		},
		permissions: (req) => sql.return(hasPermission(req.token.profile_id, req.query.board, 'can_view')),
		code: async (req, res) => {
			// Get tasks and assignees
			const results = await query<[unknown, unknown, ExpandedMember[], Task[]]>(sql.multi([
				// Get tasks
				sql.let('$tasks', sql.select<Task>([
					'id',
					'sid',
					'summary',
					'status',
					'assignee',
					'priority',
					'collection',
					'due_date',
					'tags',
					'dependencies',
					'subtasks',
					'time_created',
				], {
					from: 'tasks',
					where: sql.match<Task>({ board: req.query.board }),
					sort: 'sid',
				})),
				// Unique list of assignee ids
				sql.let('$assignees', 'array::distinct($tasks.assignee)'),
				// List of members
				sql.select<Member>(MEMBER_SELECT_FIELDS, {
					from: `${req.query.board}.domain<-member_of`,
					where: sql.match({ in: ['IN', sql.$('$assignees')] }),
				}),
				sql.return('$tasks'),
			]), { complete: true, log: req.log });
			assert(results && results.length > 0);

			const members = results[2];
			const tasks = results[3];

			// Map of members
			const memberMap: Record<string, ExpandedMember> = {};
			for (const member of members)
				memberMap[member.id] = omitBy({ ...member, is_admin: member.is_admin || undefined }, isNil) as ExpandedMember;

			return {
				tasks: tasks,
				members: memberMap,
			};
		},
	},

	"POST /tasks": {
		validate: {
			board: {
				required: true,
				location: 'body',
				transform: (value) => isRecord(value, 'boards'),
			},
			assignee: {
				required: false,
				location: 'body',
				transform: (value) => isRecord(value, 'profiles'),
			},
			collection: {
				required: false,
				location: 'body',
			},
			dependencies: {
				required: false,
				location: 'body',
				transform: (value) => isArray(value, (value) => isRecord(value, 'tasks')),
			},
			description: {
				required: false,
				location: 'body',
				transform: sanitizeHtml,
			},
			due_date: {
				required: false,
				location: 'body',
			},
			priority: {
				required: false,
				location: 'body',
			},
			status: {
				required: false,
				location: 'body',
			},
			subtasks: {
				required: false,
				location: 'body',
				transform: (value) => isArray(value, (value) => isRecord(value, 'tasks')),
			},
			summary: {
				required: true,
				location: 'body',
			},
			tags: {
				required: false,
				location: 'body',
			},
		},
		permissions: (req) => sql.return(`${hasPermission(req.token.profile_id, req.body.board, 'can_manage_tasks')} || (${req.body.assignee} == ${req.token.profile_id} && ${hasPermission(req.token.profile_id, req.body.board, 'can_manage_own_tasks')})`),
		code: async (req, res) => {
			const task = pickTask(req.body);

			// Create task
			const results = await query<[unknown, string, Task[]]>(
				sql.transaction([
					// Increment counter
					sql.update<Board>(req.body.board, { set: { _task_counter: ['+=', 1] }, return: 'NONE' }),

					// Get channel
					sql.return(`${req.body.board}.channel`),

					// Create task
					sql.create<Task>('tasks', {
						...task,
						sid: sql.$(`${req.body.board}._task_counter`),
						board: req.body.board,
						status: task.status || config.app.board.default_status_id,
					}),
				]),
				{ complete: true, log: req.log }
			);
			assert(results && results.length > 0);

			// Notify that board has changed
			const channel_id = results[1];
			emitChannelEvent(channel_id, (room) => {
				room.emit('board:activity', channel_id);
			}, { profile_id: req.token.profile_id });

			return results[2][0];
		},
	},

	"PATCH /tasks": {
		validate: {
			update: {
				required: false,
				location: 'body',
				transform: (value) => isArray(value, (value) => {
					if (!value || typeof value !== 'object')
						throw new Error('must be a task object');
					if (!value.id || typeof value.id !== 'string' || !value.id.startsWith('tasks:'))
						throw new Error('must have an "id" field in the form "tasks:[id]"');

					// Sanitize description
					if (value.description && typeof value.description === 'string')
						value.description = sanitizeHtml(value.description);

					return value;
				}),
			},
			delete: {
				required: false,
				location: 'body',
				transform: (value) => isArray(value, (value) => isRecord(value, 'tasks')),
			},
		},
		permissions: (req) => {
			const conds: string[] = [];

			// Must have update access to all tasks
			if (req.body.update)
				conds.push(`array::all((SELECT VALUE (${hasPermission(req.token.profile_id, 'task.board', 'can_manage_tasks')} || (task.assignee == ${req.token.profile_id} && (assignee = NONE || assignee == ${req.token.profile_id}) && ${hasPermission(req.token.profile_id, 'task.board', 'can_manage_own_tasks')})) FROM [${req.body.update.map(task => `{task: ${task.id}, assignee: ${task.assignee === undefined ? 'NONE' : task.assignee}}`).join(',')}]))`);

			// Must have delete access to all tasks
			if (req.body.delete)
				conds.push(`array::all((SELECT VALUE (${hasPermission(req.token.profile_id, 'task.board', 'can_manage_tasks')} || (task.assignee == ${req.token.profile_id} && ${hasPermission(req.token.profile_id, 'task.board', 'can_manage_own_tasks')})) FROM [${req.body.delete.map(id => `{task: ${id}}`).join(',')}]))`);

			return sql.return(conds.join('&&'));
		},
		code: async (req, res) => {
			const now = new Date().toISOString();

			// List of update operations
			const ops = [];

			// Get channel (of the first task being updated/deleted)
			if (req.body.update?.length || req.body.delete?.length)
				ops.push(sql.return(`${req.body.update?.length ? req.body.update[0].id : req.body.delete?.[0]}.board.channel`));

			// Update
			if (req.body.update) {
				ops.push(
					...req.body.update.map((raw) => {
						const task = pickTask(raw);
						assert(raw.id);

						return sql.update<Task>(raw.id, {
							set: {
								...task,
								time_updated: now,
								time_status_updated: task.status !== undefined ? now : undefined,
							},
						});
					})
				);
			}

			// Delete
			if (req.body.delete) {
				ops.push(
					sql.delete(req.body.delete)
				);
			}

			// Quit early if no ops
			if (ops.length === 0) return {};

			// Execute ops
			const results = await query<Task[][]>(sql.transaction(ops), { complete: true, log: req.log });
			assert(results && results.length === (req.body.update?.length || 0) + (req.body.delete ? 1 : 0) + 1);

			// Notify that board has changed
			const channel_id = results[0] as unknown as string;
			emitChannelEvent(channel_id, (room) => {
				room.emit('board:activity', channel_id);
			}, { profile_id: req.token.profile_id });
			
			if (!req.body.update) return {};
			return { updated: results.slice(1, req.body.update.length + 1).map(x => x[0]) };
		},
	},

	"GET /tasks/:task_id": {
		validate: {
			task_id: {
				required: true,
				location: 'params',
				transform: (value) => asRecord('tasks', value),
			},
		},
		permissions: (req) => sql.return(hasPermission(req.token.profile_id, `${req.params.task_id}.board`, 'can_view')),
		code: async (req, res) => {
			const results = await query<[unknown, ExpandedMember[], Task & { _domain?: string }]>(
				sql.multi([
					sql.let('$task', sql.select<Task>(['*', 'board.domain AS _domain'], { from: req.params.task_id })),
					sql.select<Member>(MEMBER_SELECT_FIELDS, {
						from: `$task._domain<-member_of`,
						where: sql.match({ in: sql.$('$task.assignee') }),
					}),
					sql.return('$task'),
				]),
				{ complete: true, log: req.log }
			);
			assert(results && results.length > 0);

			// Remove domain
			delete results[2]._domain;

			return {
				...results[2],
				assignee: results[2].assignee && results[1].length > 0 ? omitBy(results[1][0], isNil) as ExpandedMember : undefined,
			};
		},
	},

	"PATCH /tasks/:task_id": {
		validate: {
			task_id: {
				required: true,
				location: 'params',
				transform: (value) => asRecord('tasks', value),
			},
			assignee: {
				required: false,
				location: 'body',
				transform: (value) => isRecord(value, 'profiles'),
			},
			collection: {
				required: false,
				location: 'body',
			},
			dependencies: {
				required: false,
				location: 'body',
				transform: (value) => isArray(value, (value) => isRecord(value, 'tasks')),
			},
			description: {
				required: false,
				location: 'body',
				transform: sanitizeHtml,
			},
			due_date: {
				required: false,
				location: 'body',
			},
			priority: {
				required: false,
				location: 'body',
			},
			status: {
				required: false,
				location: 'body',
			},
			subtasks: {
				required: false,
				location: 'body',
				transform: (value) => isArray(value, (value) => isRecord(value, 'tasks')),
			},
			summary: {
				required: false,
				location: 'body',
			},
			tags: {
				required: false,
				location: 'body',
			},
		},
		permissions: (req) => sql.return(`${hasPermission(req.token.profile_id, `${req.params.task_id}.board`, 'can_manage_tasks')} || (${req.params.task_id}.assignee == ${req.token.profile_id} ${req.body.assignee !== undefined ? `&& ${req.body.assignee} == ${req.token.profile_id} ` : ''}&& ${hasPermission(req.token.profile_id, `${req.params.task_id}.board`, 'can_manage_own_tasks')})`),
		code: async (req, res) => {
			const task = pickTask(req.body);
			const now = new Date().toISOString();

			// Update task
			const results = await query<[string, Task[]]>(sql.multi([
				// Get channel
				sql.return(`${req.params.task_id}.board.channel`),

				sql.update<Task>(req.params.task_id, {
					content: {
						...task,
						time_updated: now,
						time_status_updated: task.status !== undefined ? now : undefined,
					},
				}),
			]), { complete: true, log: req.log });
			assert(results && results.length > 0 && results[1].length > 0);

			// Notify that board changed
			const channel_id = results[0];
			emitChannelEvent(channel_id, (room) => {
				room.emit('board:activity', channel_id);
			}, { profile_id: req.token.profile_id });

			return results[1][0];
		},
	},

	"DELETE /tasks/:task_id": {
		validate: {
			task_id: {
				required: true,
				location: 'params',
				transform: (value) => asRecord('tasks', value),
			},
		},
		permissions: (req) => sql.return(`${hasPermission(req.token.profile_id, `${req.params.task_id}.board`, 'can_manage_tasks')} || (${req.params.task_id}.assignee == ${req.token.profile_id} && ${hasPermission(req.token.profile_id, `${req.params.task_id}.board`, 'can_manage_own_tasks')})`),
		code: async (req, res) => {
			const results = await query<[string, unknown]>(sql.multi([
				sql.return(`${req.params.task_id}.board.channel`),
				sql.delete(req.params.task_id),
			]), { complete: true, log: req.log });
			assert(results && results.length > 0);

			// Notify that board changed
			const channel_id = results[0];
			emitChannelEvent(channel_id, (room) => {
				room.emit('board:activity', channel_id);
			}, { profile_id: req.token.profile_id });
		},
	},
};

export default routes;