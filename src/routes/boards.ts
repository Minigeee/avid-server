import assert from 'assert';

import { Board, Task, TaskCollection } from '@app/types';

import { hasPermission, query, sql } from '@/utility/query';
import { ApiRoutes } from '@/utility/routes';
import {  asRecord, isArray, sanitizeHtml } from '@/utility/validate';

import { pick } from 'lodash';


const routes: ApiRoutes<`${string} /boards${string}`> = {
	"GET /boards/:board_id": {
		validate: {
			board_id: {
				required: true,
				location: 'params',
				transform: (value) => asRecord('boards', value),
			},
		},
		permissions: (req) => sql.return(hasPermission(req.token.profile_id, req.params.board_id, 'can_view')),
		code: async (req, res) => {
			const results = await query<Board[]>(sql.select<Board[]>('*', { from: req.params.board_id }), { log: req.log });
			assert(results && results.length > 0);

			return results[0];
		},
	},

	"POST /boards/:board_id/collections": {
		validate: {
			board_id: {
				required: true,
				location: 'params',
				transform: (value) => asRecord('boards', value),
			},
			name: { required: true, location: 'body' },
			description: {
				required: false,
				location: 'body',
				transform: sanitizeHtml,
			},
			start_date: { required: false, location: 'body' },
			end_date: { required: false, location: 'body' },
		},
		permissions: (req) => sql.return(`${hasPermission(req.token.profile_id, req.params.board_id, 'can_manage')} || ${hasPermission(req.token.profile_id, req.params.board_id, 'can_manage_resources')}`),
		code: async (req, res) => {
			const results = await query<Board[]>(
				sql.update<Board>(req.params.board_id, {
					set: {
						collections: ['+=', {
							id: sql.$('_id_counter'),
							name: req.body.name,
							description: req.body.description,
							start_date: req.body.start_date,
							end_date: req.body.end_date,
						}],
						_id_counter: ['+=', 1],
					},
					return: ['collections', '_id_counter'],
				}),
				{ log: req.log }
			);
			assert(results && results.length > 0);

			return results[0];
		},
	},

	"PATCH /boards/:board_id/collections/:collection_id": {
		validate: {
			board_id: {
				required: true,
				location: 'params',
				transform: (value) => asRecord('boards', value),
			},
			collection_id: {
				required: true,
				location: 'params',
			},
			name: {
				required: false,
				location: 'body',
			},
			description: {
				required: false,
				location: 'body',
				transform: sanitizeHtml,
			},
			start_date: { required: false, location: 'body' },
			end_date: { required: false, location: 'body' },
		},
		permissions: (req) => sql.return(`${hasPermission(req.token.profile_id, req.params.board_id, 'can_manage')} || ${hasPermission(req.token.profile_id, req.params.board_id, 'can_manage_resources')}`),
		code: async (req, res) => {
			const collection_id = req.params.collection_id;
			const collection: Partial<TaskCollection> = pick(req.body, ['name', 'description', 'start_date', 'end_date']);

			const results = await query<Board[]>(
				sql.update<Board>(req.params.board_id, {
					set: {
						collections: sql.fn<Board>(function() {
							// Find index
							const idx = this.collections.findIndex(x => x.id === collection_id);
							if (idx >= 0)
								this.collections[idx] = { ...this.collections[idx], ...collection };

							return this.collections;
						}, { collection_id, collection }),
					},
					return: ['collections'],
				}),
				{ log: req.log }
			);
			assert(results && results.length);

			return results[0];
		},
	},

	"DELETE /boards/:board_id/collections/:collection_id": {
		validate: {
			board_id: {
				required: true,
				location: 'params',
				transform: (value) => asRecord('boards', value),
			},
			collection_id: {
				required: true,
				location: 'params',
			},
		},
		permissions: (req) => sql.return(`${hasPermission(req.token.profile_id, req.params.board_id, 'can_manage')} || ${hasPermission(req.token.profile_id, req.params.board_id, 'can_manage_resources')}`),
		code: async (req, res) => {
			const collection_id = req.params.collection_id;

			const results = await query<[Task[], Board[]]>(sql.transaction([
				sql.update<Task>('tasks', {
					content: { collection: 'backlog' },
					where: sql.match<Task>({ board: req.params.board_id, collection: req.params.collection_id }),
					return: ['id'],
				}),
				sql.update<Board>(req.params.board_id, {
					set: {
						collections: sql.fn<Board>(function() {
							return this.collections.filter(x => x.id !== req.params.collection_id);
						}, { collection_id }),
					},
					return: ['collections'],
				}),
			]), { complete: true, log: req.log });
			assert(results);

			const [tasks, newBoards] = results;
			assert(newBoards.length > 0);

			return {
				collections: newBoards[0].collections,
				tasks_changed: tasks.map(x => x.id),
			};
		},
	},

	"PATCH /boards/:board_id/tags": {
		validate: {
			board_id: {
				required: true,
				location: 'params',
				transform: (value) => asRecord('boards', value),
			},
			add: {
				required: false,
				location: 'body',
				transform: (value) => isArray(value, (value) => {
					if (!value || typeof value !== 'object' || !value.label || typeof value.label !== 'string')
						throw new Error('must be a label object with a string `label` fields');
					return value;
				}),
			},
			update: {
				required: false,
				location: 'body',
				transform: (value) => isArray(value, (value) => {
					if (!value || typeof value !== 'object' || !value.label || typeof value.label !== 'string')
						throw new Error('must be a label object with a string `label` fields');
					if (!value.id || typeof value.id !== 'string')
						throw new Error('must have an `id` field to indicate which tag to update');
					return value;
				}),
			},
		},
		permissions: (req) => sql.return(`${hasPermission(req.token.profile_id, req.params.board_id, 'can_manage')} || ${hasPermission(req.token.profile_id, req.params.board_id, 'can_manage_resources')}`),
		code: async (req, res) => {
			const add = req.body.add || [];
			const update = req.body.update || [];

			const results = await query<Board[]>(
				sql.update<Board>(req.params.board_id, {
					set: {
						// Function that updates existing tags and adds new ones
						tags: sql.fn<Board>(function() {
							// Merge updates
							for (const tag of update) {
								const idx = this.tags.findIndex(x => x.id === tag.id);
								if (idx >= 0)
									this.tags[idx] = { ...this.tags[idx], ...tag };
							}

							// Add new tags
							return this.tags.concat(add.map((x, i) => ({ ...x, id: (this._id_counter + i).toString() })));
						}, { add, update }),

						_id_counter: ['+=', add.length],
					},
					return: ['tags', '_id_counter'],
				}),
				{ log: req.log }
			);
			assert(results && results[0]);

			// WIP : Change use-board to use api

			return results[0];
		},
	},
};

export default routes;