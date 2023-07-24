import assert from 'assert';

import { ExpandedMember, Member } from '@app/types';

import config from '@/config';
import { hasMemberPermission, hasPermission, isMember, query, sql } from '@/utility/query';
import { ApiRoutes } from '@/utility/routes';
import { asArray, asBool, asInt, asRecord, isArray, isRecord } from '@/utility/validate';

import { isNil, omitBy } from 'lodash';


/** Fields that should be selected by member queries */
export const MEMBER_SELECT_FIELDS = [
	'in AS id',
	'is_admin',
	'is_owner',
	'alias',
	'roles',
	'in.profile_picture AS profile_picture',
	'in.online AS online',
];


const routes: ApiRoutes<`${string} /members${string}`> = {
	"GET /members": {
		validate: {
			domain: {
				required: true,
				location: 'query',
				transform: (value) => asRecord('domains', value),
			},
			ids: {
				required: false,
				location: 'query',
				transform: (value) => asArray(value, (value) => asRecord('profiles', value), { maxlen: 1000 }),
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
			search: {
				required: false,
				location: 'query',
				transform: (value: string) => {
					if (value.length > 100)
						throw new Error('must be a string with length <100');
					return value.toLocaleLowerCase();
				},
			},
			role: {
				required: false,
				location: 'query',
				transform: (value) => asRecord('roles', value),
			},
			exclude_role: {
				required: false,
				location: 'query',
				transform: (value) => asRecord('roles', value),
			},
			online: {
				required: false,
				location: 'query',
				transform: (value) => asBool(value),
			},
			with_data: {
				required: false,
				location: 'query',
				transform: (value) => asBool(value),
			},
		},
		// User needs to be a member of the domain to view its members
		permissions: (req) => sql.return(isMember(req.token.profile_id, req.query.domain)),
		code: async (req, res) => {
			if (req.query.ids) {
				const results = await query<ExpandedMember[]>(
					sql.select<Member>(MEMBER_SELECT_FIELDS, {
						from: `${req.query.domain}<-member_of`,
						where: sql.match({ in: ['IN', req.query.ids] }),
					}),
					{ log: req.log }
				);
				assert(results);
				
				return results.map(x => omitBy(x, isNil)) as ExpandedMember[];
			}
			else {
				// Match string
				let matchConstraints: string[] = [];
				if (req.query.search)
					matchConstraints.push(`string::lowercase(alias) CONTAINS '${req.query.search}'`);
				if (req.query.role)
					matchConstraints.push(`roles CONTAINS ${req.query.role}`);
				else if (req.query.exclude_role)
					matchConstraints.push(`roles CONTAINSNOT ${req.query.exclude_role}`);
				if (req.query.online !== undefined)
					matchConstraints.push(`in.online${req.query.online ? '=true' : '!=true'}`);
				const matchStr = matchConstraints.join('&&');

				// Limit
				const limit = Math.min(req.query.limit || config.db.page_size.members, 1000);

				const ops: string[] = [];

				// Query for actual data
				const withData = req.query.with_data !== false;
				if (withData) {
					ops.push(
						sql.select<Member>(MEMBER_SELECT_FIELDS, {
							from: `${req.query.domain}<-member_of`,
							where: matchStr || undefined,
							limit: limit,
							start: req.query.page !== undefined ? req.query.page * limit : undefined,
							sort: [{ field: 'is_admin', order: 'DESC' }, { field: 'alias', mode: 'COLLATE' }],
						})
					);
				}

				// Query for count
				ops.push(
					sql.select<Member>(['count()'], {
						from: `${req.query.domain}<-member_of`,
						where: matchStr || undefined,
						group: 'all',
					})
				);

				// Create query string
				const results = await query<any[]>(sql.multi(ops), { complete: true, log: req.log });
				assert(results && results.length > 0);

				return {
					data: withData ? results[0].map((x: any) => omitBy(x, isNil)) : [],
					count: results[results.length - 1].length > 0 ? results[results.length - 1][0].count : 0
				};
			}
		},
	},

	"GET /members/:member_id": {
		validate: {
			member_id: {
				required: true,
				location: 'params',
				transform: (value) => asRecord('profiles', value),
			},
			domain: {
				required: true,
				location: 'query',
				transform: (value) => asRecord('domains', value),
			},
		},
		// User needs to be a member of the domain to view its members
		permissions: (req) => sql.return(isMember(req.token.profile_id, req.query.domain)),
		code: async (req, res) => {
			const results = await query<ExpandedMember[]>(
				sql.select<Member>(MEMBER_SELECT_FIELDS, {
					from: `${req.query.domain}<-member_of`,
					where: sql.match({ in: req.params.member_id }),
				}),
				{ log: req.log }
			);
			assert(results && results.length > 0);

			return results[0];
		},
	},

	"DELETE /members/:member_id": {
		validate: {
			domain: {
				required: true,
				location: 'query',
				transform: (value) => asRecord('domains', value),
			},
			member_id: {
				required: true,
				location: 'params',
				transform: (value) => asRecord('profiles', value),
			},
		},
		// Can delete member if the user can kick or ban
		permissions: (req) => sql.return(`${hasPermission(req.token.profile_id, req.query.domain, 'can_kick_member', req.query.domain)} || ${hasPermission(req.token.profile_id, req.query.domain, 'can_ban_member', req.query.domain)}`),
		code: async (req, res) => {
			// Delete member
			await query<ExpandedMember[]>(
				sql.delete<Member>(`${req.query.domain}<-member_of`, {
					where: sql.match({ in: req.params.member_id }),
				}),
				{ log: req.log }
			);

			// TODO : Broadcast event
		},
	},

	"PATCH /members/:member_id/roles": {
		validate: {
			domain: {
				required: true,
				location: 'query',
				transform: (value) => asRecord('domains', value),
			},
			member_id: {
				required: true,
				location: 'params',
				transform: (value) => asRecord('profiles', value),
			},
			roles: {
				required: true,
				location: 'body',
				transform: (value) => isArray(value, (value) => isRecord(value, 'roles')),
			},
		},
		// Can add roles if the user can manage the member's roles or if the user can assign all roles being added
		permissions: (req) => sql.return(`${hasMemberPermission(req.token.profile_id, req.params.member_id, 'can_manage_member_roles', req.query.domain)} || array::all((SELECT VALUE ${hasPermission(req.token.profile_id, 'value', 'can_assign_role', req.query.domain)} FROM [${req.body.roles.map(x => `{value: ${x}}`)}]))`),
		code: async (req, res) => {
			const results = await query<Member[]>(
				sql.update<Member>(`${req.query.domain}<-member_of`, {
					where: sql.match({ in: req.params.member_id }),
					set: { roles: ['+=', req.body.roles] },
					return: ['roles']
				}),
				{ log: req.log }
			);
			assert(results && results.length > 0);

			return results[0].roles || [];
		},
	},

	"DELETE /members/:member_id/roles/:role_id": {
		validate: {
			domain: {
				required: true,
				location: 'query',
				transform: (value) => asRecord('domains', value),
			},
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
		permissions: (req) => sql.return(`${hasMemberPermission(req.token.profile_id, req.params.member_id, 'can_manage_member_roles', req.query.domain)} || ${hasPermission(req.token.profile_id, req.params.role_id, 'can_assign_role', req.query.domain)}`),
		code: async (req, res) => {
			// Remove role
			const results = await query<Member[]>(
				sql.update<Member>(`${req.query.domain}<-member_of`, {
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