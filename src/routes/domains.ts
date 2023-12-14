import assert from 'assert';

import { AclEntry, AllPermissions, Channel, ChannelGroup, Domain, ExpandedDomain, Member, Role, UserPermissions } from '@app/types';

import { canViewAcl, getMember, hasPermission, hasPermissionUsingMember, isMember, query, sql } from '../utility/query';
import { ApiRoutes } from '../utility/routes';
import { asRecord, isArray, isRecord } from '../utility/validate';


////////////////////////////////////////////////////////////
const TEMPLATES = {
	default: () => ([
		sql.let('$groups', '[]'),
		sql.let('$group', sql.single(sql.create<ChannelGroup>('channel_groups', {
			domain: sql.$('$domain.id'),
			name: 'Main',
			channels: sql.$('[]'),
		}))),
		sql.update<ChannelGroup>('($group.id)', {
			set: {
				channels: sql.$(sql.wrap(
					sql.create<Channel>('channels', {
						domain: sql.$('$domain.id'),
						inherit: sql.$('$group.id'),
						name: 'general',
						type: 'text',
					}),
					{ append: '.id' }
				)),
			},
		}),
		sql.create<AclEntry>('acl', {
			domain: sql.$('$domain.id'),
			resource: sql.$('$group.id'),
			role: sql.$('$role.id'),
			permissions: [
				'can_view',
				'can_send_messages',
				'can_send_attachments',
				'can_send_reactions',
				'can_broadcast_audio',
				'can_broadcast_video',
			],
		}),
		sql.let('$groups', `array::append($groups, $group.id)`),
	]),
};


const routes: ApiRoutes<`${string} /domains${string}`> = {
	"POST /domains": {
		validate: {
			name: {
				required: true,
				location: 'body',
			},
		},
		// TODO : Limit on how many domains a user can own
		code: async (req, res) => {
			// Create new domain with the specified name and make user join
			const results = await query<Domain>(sql.transaction([
				// Create domain
				sql.let('$domain', sql.single(sql.create<Domain>('domains', {
					name: req.body.name,
					groups: [],
				}))),
				// Create everyone role
				sql.let('$role', sql.single(sql.create<Role>('roles', {
					domain: sql.$('$domain.id'),
					label: 'everyone',
				}))),
				// Create starting template configuration
				...TEMPLATES.default(),
				// Add starting config to domain
				sql.let('$domain', sql.single(sql.update<Domain>('$domain', {
					set: {
						_default_role: sql.$('$role.id'),
						groups: sql.$('$groups'),
					},
				}))),
				// Add member to domain as owner/admin
				sql.relate<Member>(req.token.profile_id, 'member_of', '$domain', {
					content: {
						alias: sql.$(`${req.token.profile_id}.username`),
						roles: [sql.$('$role.id')],
						is_owner: true,
						is_admin: true,
					},
				}),
				// Return id of domain
				sql.return('$domain'),
			]), { log: req.log });
			assert(results);

			return results;
		},
	},

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

	"GET /domains/join/:join_id": {
		validate: {
			join_id: {
				required: true,
				location: 'params',
			},
		},
		code: async (req, res) => {
			const domain_id = asRecord('domains', req.params.join_id);

			// Try adding member
			const results = await query<(Domain & { members: string[] })[]>(
				sql.select<Domain>([
					'name',
					'icon',
					sql.wrap(`<-(member_of WHERE in = ${req.token.profile_id})`, { alias: 'members' })
				], {
					from: domain_id,
				}),
				{ log: req.log }
			);
			assert(results && results.length > 0);

			return { name: results[0].name, icon: results[0].icon, is_member: results[0].members.length > 0 };
		},
	},

	"POST /domains/join/:join_id": {
		validate: {
			join_id: {
				required: true,
				location: 'params',
			},
		},
		// TODO : Rework this in the invitation system
		code: async (req, res) => {
			const domain_id = asRecord('domains', req.params.join_id);

			// Try adding member
			const results = await query<Domain>(sql.multi([
				sql.let('$domain', sql.single(sql.select<Domain>(['id', 'name', 'icon', '_default_role'], { from: domain_id }))),
				sql.relate<Member>(req.token.profile_id, 'member_of', '$domain', {
					content: {
						alias: sql.$(`${req.token.profile_id}.username`),
						roles: [sql.$('$domain._default_role')],
					}
				}),
				sql.return('$domain'),
			]), { log: req.log });
			assert(results);

			return results;
		},
	},
};

export default routes;