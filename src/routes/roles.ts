import assert from 'assert';

import { Domain, ExpandedMember, Member, Role } from '@app/types';

import { hasMemberPermission, hasPermission, isMember, new_Record, query, sql } from '@/utility/query';
import { ApiRoutes } from '@/utility/routes';
import { asRecord, isArray, isRecord } from '@/utility/validate';
import { MEMBER_SELECT_FIELDS } from './members';


const routes: ApiRoutes<`${string} /roles${string}`> = {
	"GET /roles": {
		validate: {
			domain: {
				required: true,
				location: 'query',
				transform: (value) => asRecord('domains', value),
			},
		},
		permissions: (req) => sql.return(isMember(req.token.profile_id, req.query.domain)),
		code: async (req, res) => {
			const results = await query<Role[]>(
				sql.select<Role>('*', { from: 'roles', where: sql.match<Role>({ domain: req.query.domain }) }),
				{ log: req.log }
			);
			assert(results);

			return results;
		},
	},

	"POST /roles": {
		validate: {
			domain: {
				required: true,
				location: 'body',
				transform: (value) => isRecord(value, 'domains'),
			},
			label: {
				required: false,
				location: 'body',
			},
		},
		permissions: (req) => sql.return(hasPermission(req.token.profile_id, req.body.domain, 'can_create_roles', req.body.domain)),
		code: async (req, res) => {
			const results = await query<Role[]>(
				sql.create<Role>('roles', {
					domain: req.body.domain,
					label: req.body.label || 'New Role',
				}),
				{ log: req.log }
			);
			assert(results && results.length > 0);

			return results[0];
		},
	},

	"PATCH /roles": {
		validate: {
			roles: {
				required: true,
				location: 'body',
				transform: (value) => {
					if (!Array.isArray(value))
						throw new Error('must be an array of role objects to update where each object must contain an `id` value');

					for (let i = 0; i < value.length; ++i) {
						const role = value[i];
						if (typeof role !== 'object' || !role.id?.startsWith('roles:'))
							throw new Error(`[${i}] must be a role object with an \`id\` property in the form "roles:[id]"`);
					}

					return value;
				},
			}
		},
		permissions: (req) => sql.return(`array::all((SELECT VALUE ${hasPermission(req.token.profile_id, 'value', 'can_manage')} FROM [${req.body.roles.map(x => `{value: ${x.id}}`).join(',')}]))`),
		code: async (req, res) => {
			if (req.body.roles.length === 0) return [];

			const results = await query<Role[][]>(sql.transaction(
				req.body.roles.map(role => sql.update<Role>(role.id || '', {
					set: {
						badge: role.badge,
						label: role.label,
						show_badge: role.show_badge,
					},
				}))
			), { complete: true, log: req.log });
			assert(results && results.length === req.body.roles.length);

			return results.map(x => x[0]);
		},
	},

	"PATCH /roles/:role_id": {
		validate: {
			role_id: {
				required: true,
				location: 'params',
				transform: (value) => asRecord('roles', value),
			},
			label: {
				required: false,
				location: 'body',
			},
			badge: {
				required: false,
				location: 'body',
			},
			show_badge: {
				required: false,
				location: 'body',
			},
			after: {
				required: false,
				location: 'body',
				transform: (value) => value === null ? null : asRecord('roles', value),
			},
		},
		permissions: (req) => {
			const ops = [];

			// Check if modifying role
			if (req.body.label !== undefined || req.body.badge !== undefined || req.body.show_badge !== undefined)
				ops.push(hasPermission(req.token.profile_id, req.params.role_id, 'can_manage'));
			// Check if user can manage domain if order being changed
			if (req.body.after !== undefined)
				ops.push(hasPermission(req.token.profile_id, `${req.params.role_id}.domain`, 'can_manage'));

			return sql.return(ops.join('&&'));
		},
		code: async (req, res) => {
			const ops: string[] = [];

			// Update order
			if (req.body.after !== undefined) {
				const role_id = req.params.role_id.split(':')[1];
				const before = req.body.after;

				ops.push(
					sql.update<Domain>(`(${req.params.role_id}.domain)`, {
						set: {
							roles: sql.fn<Domain>(function () {
								const targetRecord = `roles:${role_id}`;

								const from = this.roles.findIndex(x => x.toString() === targetRecord);
								const to = before ? this.roles.findIndex(x => x.toString() === before) + 1 : 0;

								if (from >= 0)
									this.roles.splice(from, 1);
								this.roles.splice(to, 0, new_Record('roles', role_id));

								return this.roles;
							}, { before, role_id }),
						},
						return: ['roles'],
					})
				);
			}

			// Update actual role
			if (req.body.label !== undefined || req.body.badge !== undefined || req.body.show_badge !== undefined) {
				ops.push(sql.update<Role>(req.params.role_id, {
					set: {
						badge: req.body.badge,
						label: req.body.label,
						show_badge: req.body.show_badge,
					},
				}));
			}

			// Quit early if no update provided
			if (ops.length === 0) return {};

			const results = await query<(Role[] | { roles: string[] }[])[]>(sql.transaction(ops), { complete: true, log: req.log });
			assert(results && results.length > 0);

			const reorder = req.body.after !== undefined;
			return {
				role: (reorder ? results.length > 1 ? results[1][0] : undefined : results[0][0]) as Role,
				order: reorder ? (results[0] as { roles: string[] }[])[0].roles : undefined,
			};
		},
	},

	"DELETE /roles/:role_id": {
		validate: {
			role_id: {
				required: true,
				location: 'params',
				transform: (value) => asRecord('roles', value),
			},
		},
		permissions: (req) => sql.return(hasPermission(req.token.profile_id, req.params.role_id, 'can_delete_role')),
		code: async (req, res) => {
			await query<Role[]>(
				sql.delete<Role>(req.params.role_id),
				{ log: req.log }
			);

			// TODO : Broadcast event
		},
	},

	"PATCH /roles/:role_id/members": {
		validate: {
			role_id: {
				required: true,
				location: 'params',
				transform: (value) => asRecord('roles', value),
			},
			members: {
				required: true,
				location: 'body',
				transform: (value) => isArray(value, (value) => isRecord(value, 'profiles')),
			},
		},
		permissions: (req) => sql.return(`${hasPermission(req.token.profile_id, req.params.role_id, 'can_assign_role')} || array::all((SELECT VALUE ${hasMemberPermission(req.token.profile_id, 'value', 'can_manage_member_roles', `${req.params.role_id}.domain`)} FROM [${req.body.members.map(x => `{value: ${x}}`)}]))`),
		code: async (req, res) => {
			const results = await query<ExpandedMember[]>(
				sql.update<Member>(`(${req.params.role_id}.domain<-member_of)`, {
					set: { roles: ['+=', req.params.role_id] },
					where: sql.match({ in: ['IN', req.body.members] }),
					return: MEMBER_SELECT_FIELDS,
				}),
				{ log: req.log }
			);
			assert(results && results.length === req.body.members.length);

			return results;
		},
	},

	"DELETE /roles/:role_id/members/:member_id": {
		validate: {
			member_id: {
				required: true,
				location: 'params',
				transform: (value) => asRecord('profiles', value),
			},
			role_id: {
				required: true,
				location: 'params',
				transform: (value) => asRecord('roles', value),
			},
		},
		// Can add roles if the user can manage the member's roles or if the user can assign all roles being added
		permissions: (req) => sql.return(`${hasMemberPermission(req.token.profile_id, req.params.member_id, 'can_manage_member_roles', `${req.params.role_id}.domain`)} || ${hasPermission(req.token.profile_id, req.params.role_id, 'can_assign_role')}`),
		code: async (req, res) => {
			// Remove role
			const results = await query<Member[]>(
				sql.update<Member>(`(${req.params.role_id}.domain<-member_of)`, {
					where: sql.match({ in: req.params.member_id }),
					set: { roles: ['-=', req.params.role_id] },
					return: ['roles']
				}),
				{ log: req.log }
			);
			assert(results && results.length > 0);

			return results[0].roles || [];
		},
	},
};

export default routes;