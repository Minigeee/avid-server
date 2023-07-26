import assert from 'assert';

import { AclEntry, AllPermissions, Channel, ChannelGroup, Domain, ExpandedDomain, Member, Role, UserPermissions } from '@app/types';

import { canViewAcl, getMember, hasPermission, hasPermissionUsingMember, isMember, query, sql } from '../utility/query';
import { ApiRoutes } from '../utility/routes';
import { asRecord, isArray, isRecord } from '../utility/validate';


const routes: ApiRoutes<`${string} /domains${string}`> = {
	"GET /domains/:domain_id": {
		validate: {
			domain_id: {
				required: true,
				location:'params',
				transform: (value) => asRecord('domains', value),
			},
		},
		permissions: (req) => sql.return(isMember(req.token.profile_id, req.params.domain_id)),
		code: async (req, res) => {
			const results = await query<[unknown, AclEntry[], Channel[], ChannelGroup[], Role[], Domain[], Member]>(
				sql.multi([
					sql.let('$member', getMember(req.token.profile_id, req.params.domain_id)),
					sql.select<AclEntry>([
						'domain',
						'resource',
						'role',
						'permissions',
					], {
						from: 'acl',
						where: `${sql.match<AclEntry>({
							domain: req.params.domain_id,
							role: ['IN', sql.$('$member.roles')]
						})} && ${canViewAcl('resource', 'role')}`,
					}),
					sql.select<Channel>('*', {
						from: 'channels',
						where: `${sql.match({ domain: req.params.domain_id })} && ${hasPermissionUsingMember('id', 'can_view')}`,
					}),
					sql.select<ChannelGroup>('*', {
						from: 'channel_groups',
						where: `${sql.match({ domain: req.params.domain_id })} && ${hasPermissionUsingMember('id', 'can_view')}`,
					}),
					sql.select<Role>('*', {
						from: 'roles',
						where: sql.match({ domain: req.params.domain_id }),
					}),
					sql.select<Domain>('*', { from: req.params.domain_id }),
					sql.return('$member'),
				]),
				{ complete: true, log: req.log }
			);
			assert(results);

			// Unwrap
			const [_, entries, channels, groups, roles, domains, member] = results;
			assert(domains.length > 0);

			// Member info
			const info: Omit<UserPermissions, 'permissions'> & { permissions: Record<string, Set<string> | string[]> } = {
				roles: member.roles || [],
				is_admin: member.is_admin || false,
				is_owner: member.is_owner || false,
				permissions: {},
				entries: entries.map(x => ({ ...x, permissions: x.permissions || [] })),
			};

			// Add entries to map
			for (const entry of entries) {
				if (!info.permissions[entry.resource])
					info.permissions[entry.resource] = new Set<AllPermissions>(entry.permissions);
				else {
					const set = info.permissions[entry.resource] as Set<string>;
					for (const perm of entry.permissions)
						set.add(perm);
				}
			}

			// Convert to arrays to send data
			for (const [resource, perms] of Object.entries(info.permissions))
				info.permissions[resource] = Array.from(perms);

			// Map channel id to channel object
			const channelMap: Record<string, Channel> = {};
			for (const channel of channels)
				channelMap[channel.id] = channel;

			// List of groups in correct order
			const groupMap: Record<string, ChannelGroup> = {};
			for (const group of groups)
				groupMap[group.id] = group;

			const groupArr: ChannelGroup[] = [];
			for (const id of domains[0].groups) {
				if (!groupMap[id]) continue;
				groupArr.push(groupMap[id]);
				delete groupMap[id];
			}
			groupArr.push(...Object.values(groupMap));

			// List of roles in correct order
			const roleMap: Record<string, Role> = {};
			for (const role of roles)
				roleMap[role.id] = role;

			const roleArr: Role[] = [];
			for (const id of domains[0].roles) {
				if (!roleMap[id]) continue;
				roleArr.push(roleMap[id]);
				delete roleMap[id];
			}
			roleArr.push(...Object.values(roleMap));

			return {
				...domains[0],
				channels: channelMap,
				groups: groupArr.map(group => ({
					...group,
					channels: group.channels.filter(id => channelMap[id]),
				})),
				roles: roleArr,
				_permissions: info,
			} as ExpandedDomain;
		},
	},

	"PATCH /domains/:domain_id": {
		validate: {
			domain_id: {
				required: true,
				location: 'params',
				transform: (value) => asRecord('domains', value),
			},
			name: {
				required: false,
				location: 'body',
			},
		},
		permissions: (req) => sql.return(hasPermission(req.token.profile_id, req.params.domain_id, 'can_manage', req.params.domain_id)),
		code: async (req, res) => {
			const results = await query<Domain[]>(
				sql.update<Domain>(req.params.domain_id, {
					set: { name: req.body.name },
					return: ['name'],
				}),
				{ log: req.log }
			);
			assert(results && results.length > 0);

			return results[0];
		},
	},

	"PUT /domains/:domain_id/role_order": {
		validate: {
			domain_id: {
				required: true,
				location: 'params',
				transform: (value) => asRecord('domains', value),
			},
			roles: {
				required: true,
				location: 'body',
				transform: (value) => isArray(value, (value) => isRecord(value, 'roles')),
			},
		},
		permissions: (req) => sql.return(hasPermission(req.token.profile_id, req.params.domain_id, 'can_manage', req.params.domain_id)),
		code: async (req, res) => {
			const results = await query<Domain[]>(
				sql.update<Domain>(req.params.domain_id, {
					set: { roles: req.body.roles },
					return: ['roles'],
				}),
				{ log: req.log }
			);
			assert(results && results.length > 0);

			return results[0];
		},
	},
};

export default routes;