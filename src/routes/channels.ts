import assert from 'assert';

import { Board, Channel, ChannelGroup, ChannelOptions, ChannelTypes } from '@app/types';

import config from '../config';
import { getMember, hasPermission, hasPermissionUsingMember, isMember, new_Record, query, sql } from '../utility/query';
import { ApiRoutes } from '../utility/routes';
import { asRecord, isIn, isRecord } from '../utility/validate';

import { pick } from 'lodash';


const routes: ApiRoutes<`${string} /channels${string}`> = {
	"GET /channels": {
		validate: {
			domain: {
				required: true,
				location: 'query',
				transform: (value) => asRecord('domains', value),
			},
		},
		permissions: (req) => sql.return(isMember(req.token.profile_id, req.query.domain)),
		code: async (req, res) => {
			const results = await query<Channel[]>(sql.multi([
				sql.let('$member', getMember(req.token.profile_id, req.query.domain)),
				sql.select<Channel>('*', {
					from: 'channels',
					where: `${sql.match({ domain: req.query.domain })} && ${hasPermissionUsingMember('id', 'can_view')}`,
				}),
			]), { log: req.log });
			assert(results);

			return results;
		},
	},

	"POST /channels": {
		validate: {
			domain: {
				required: true,
				location: 'body',
				transform: (value) => isRecord(value, 'domains'),
			},
			group: {
				required: true,
				location: 'body',
				transform: (value) => isRecord(value, 'channel_groups'),
			},
			name: {
				required: false,
				location: 'body',
			},
			type: {
				required: true,
				location: 'body',
				transform: (value) => isIn<ChannelTypes>(value, ['text', 'rtc', 'board']),
			},
			data: {
				required: false,
				location: 'body',
				transform: (value, req) => {
					const { type } = req.body;
					if (type === 'rtc') {
						if (!value.max_participants || typeof value.max_participants !== 'number')
							value.max_participants = 50;
					}

					return value;
				},
			},
			options: {
				required: false,
				location: 'body',
				transform: (value, req) => {
					const { type } = req.body;
					if (type === 'board') {
						if (!value.prefix || typeof value.prefix !== 'string')
							throw new Error('must contain a string "prefix" field');
					}

					return value;
				},
			},
		},
		permissions: (req) => sql.return(hasPermission(req.token.profile_id, req.body.group, 'can_manage_resources', req.body.domain)),
		code: async (req, res) => {
			// Data object
			const data: any = pick(req.body.data, ['max_participants']);
			const { type } = req.body;

			// List of operations
			const ops: string[] = [];

			// Board
			if (type === 'board') {
				const opts = req.body.options as ChannelOptions<'board'>;

				ops.push(
					sql.let('$board', sql.create<Board>('boards', {
						domain: req.body.domain,
						inherit: req.body.group,
						prefix: opts.prefix,
						statuses: config.app.board.default_statuses,
						tags: [],
						collections: [config.app.board.backlog_collection],
			
						_task_counter: 0,
						_id_counter: 1,
					}, ['id']))
				);

				data.board = sql.$('$board.id');
			}

			// RTC
			else if (type === 'rtc') {
				data.participants = [];
			}

			// Create channel
			ops.push(
				sql.let('$channel', sql.create<Channel>('channels', {
					domain: req.body.domain,
					inherit: req.body.group,
					name: req.body.name || 'new-channel',
					type: req.body.type,
					data,
				}))
			);

			// Board
			if (type === 'board') {
				ops.push(sql.update<Board>('($board.id)', {
					set: { channel: sql.$('$channel.id') },
					return: 'NONE',
				}));
			}

			// Return channel
			ops.push(sql.return('$channel'));

			// Perform query
			const results = await query<Channel>(sql.transaction(ops), { log: req.log });
			assert(results);

			return results;
		},
	},

	"GET /channels/:channel_id": {
		validate: {
			channel_id: {
				required: true,
				location: 'params',
				transform: (value) => asRecord('channels', value),
			},
		},
		permissions: (req) => sql.return(hasPermission(req.token.profile_id, req.params.channel_id, 'can_view')),
		code: async (req, res) => {
			const results = await query<Channel[]>(
				sql.select<Channel>('*', { from: req.params.channel_id }),
				{ log: req.log }
			);
			assert(results && results.length > 0);

			return results[0];
		},
	},

	"PATCH /channels/:channel_id": {
		validate: {
			channel_id: {
				required: true,
				location: 'params',
				transform: (value) => asRecord('channels', value),
			},
			name: {
				required: false,
				location: 'body',
			},
			group: {
				required: false,
				location: 'body',
				transform: (value, req) => {
					if (req.body.after === undefined)
						throw new Error('can only be used if "body.after" is also present');
					return isRecord(value, 'channel_groups');
				},
			},
			after: {
				required: false,
				location: 'body',
				transform: (value) => value === null ? null : isRecord(value, 'channels'),
			},
		},
		permissions: (req) => {
			const ops: string[] = [sql.let('$member', getMember(req.token.profile_id, `${req.params.channel_id}.domain`))];

			// Conditions for modifying
			const conds: string[] = [];

			// Modyfing channel
			if (req.body.name !== undefined)
				conds.push(`(${hasPermissionUsingMember(req.params.channel_id, 'can_manage')} || ${hasPermissionUsingMember(req.params.channel_id, 'can_manage_resources')})`);

			if (req.body.after !== undefined) {
				// The group the channel is being moved from
				ops.push(
					sql.let('$old_group', `${req.params.channel_id}.inherit || ${sql.wrap(
						sql.select<ChannelGroup>(
							['VALUE id'], {
							from: 'channel_groups',
							where: sql.match<ChannelGroup>({ channels: ['CONTAINS', req.params.channel_id] }),
						}),
						{ append: '[0]' }
					)}`)
				);

				// Condition for moving within source group
				conds.push(`(${hasPermissionUsingMember('$old_group', 'can_manage')} || ${hasPermissionUsingMember('$old_group', 'can_manage_resources')})`);

				// Add condition for moving to a new dest group
				if (req.body.group !== undefined)
					conds.push(`(${hasPermissionUsingMember(req.body.group, 'can_manage')} || ${hasPermissionUsingMember(req.body.group, 'can_manage_resources')})`);
			}

			return sql.multi([
				...ops,
				sql.return(conds.join('&&')),
			]);
		},
		code: async (req, res) => {
			const ops: string[] = [];
			
			// Channel order
			if (req.body.after !== undefined) {
				// Id of the channel before dst index
				const before = req.body.after;
				// The id of the channel being moved
				const target_id = req.params.channel_id.split(':')[1];

				// Indicates if channel is staying in the same group
				const same = req.body.group === undefined;
				
				// The group the channel is being moved from
				ops.push(
					sql.let('$old_group', `${req.params.channel_id}.inherit || ${sql.wrap(
						sql.select<ChannelGroup>(
							['VALUE id'], {
							from: 'channel_groups',
							where: sql.match<ChannelGroup>({ channels: ['CONTAINS', req.params.channel_id] }),
						}),
						{ append: '[0]' }
					)}`)
				);

				// Handle within group move
				if (same) {
					ops.push(sql.update<ChannelGroup>('($old_group)', {
						set: {
							channels: sql.fn<ChannelGroup>(function () {
								const targetRecord = `channels:${target_id}`;

								const from = this.channels.findIndex(x => x.toString() === targetRecord);
								const to = before ? this.channels.findIndex(x => x.toString() === before) + 1 : 0;

								if (from >= 0)
									this.channels.splice(from, 1);
								this.channels.splice(to, 0, new_Record('channels', target_id));

								return this.channels;
							}, { before, target_id }),
						},
					}));
				}

				// Handle move to new group
				else {
					assert(req.body.group);

					// Modify src group
					ops.push(sql.update<ChannelGroup>('($old_group)', {
						set: {
							channels: sql.fn<ChannelGroup>(function () {
								const from = this.channels.findIndex(x => x.toString() === target_id);
								if (from >= 0)
									this.channels.splice(from, 1);

								return this.channels;
							}, { target_id: `channels:${target_id}` }),
						},
					}));

					// Modify dst group
					ops.push(sql.update<ChannelGroup>(req.body.group, {
						set: {
							channels: sql.fn<ChannelGroup>(function () {
								const to = before ? this.channels.findIndex(x => x.toString() === before) + 1 : 0;
								this.channels.splice(to, 0, new_Record('channels', target_id));

								return this.channels;
							}, { before, target_id }),
						},
					}));

					// Switch inherited channel group if needed
					ops.push(
						sql.let('$inherit', sql.if({ cond: `${req.params.channel_id}.inherit == NONE`, body: 'NONE' }, { body: req.body.group }))
					);

					// Update channel
					ops.push(
						sql.update<Channel>(req.params.channel_id, {
							set: { inherit: sql.$('$inherit') }
						})
					);

					// Update others
					ops.push(
						sql.if({
							cond: `${req.params.channel_id}.type == "board"`,
							body: sql.update<Board>(`${req.params.channel_id}.data.board`, {
								set: { inherit: sql.$('$inherit') }
							}),
						})
					);
				}
			}

			// Channel name
			const updateChannel = req.body.name !== undefined;
			if (updateChannel) {
				ops.push(
					sql.update<Channel>(req.params.channel_id, {
						set: { name: req.body.name },
						return: ['name'],
					})
				);
			}

			// Perform transaction
			const results = await query<Channel[]>(sql.transaction(ops), { log: req.log });
			assert(results);

			return updateChannel ? results[0] : null;
		},
	},

	"DELETE /channels/:channel_id": {
		validate: {
			channel_id: {
				required: true,
				location: 'params',
				transform: (value) => asRecord('channels', value),
			},
		},
		permissions: (req) => sql.return(hasPermission(req.token.profile_id, req.params.channel_id, 'can_manage_resources')),
		code: async (req, res) => {
			await query(sql.delete(req.params.channel_id), { log: req.log });
		},
	},
};

export default routes;