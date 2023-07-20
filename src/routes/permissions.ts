import assert from 'assert';

import { AclEntry, Member } from '@app/types';

import { canModifyAcl, canViewAcl, getMember, isMember, query, sql } from '@/utility/query';
import { ApiRoutes } from '@/utility/routes';
import { asRecord, isArray, isRecord } from '@/utility/validate';

import { StatusError } from '@/utility/error';


const routes: ApiRoutes<`${string} /permissions${string}`> = {
	"GET /permissions": {
		validate: {
			domain: {
				required: false,
				location: 'query',
				transform: (value) => asRecord('domains', value),
			},
			resource: {
				required: false,
				location: 'query',
				transform: (value, req) => {
					if (!req.query.resource_type)
						throw new Error('requires a valid "query.resource_type"');
					return asRecord(req.query.resource_type, value);
				},
			},
			resource_type: {
				required: false,
				location: 'query',
			},
			role: {
				required: false,
				location: 'query',
				transform: (value) => asRecord('roles', value),
			},
		},
		permissions: (req) => {
			if (req.query.domain)
				return sql.return(isMember(req.token.profile_id, req.query.domain));
			else if (req.query.role)
				return sql.return(isMember(req.token.profile_id, `${req.query.role}.domain`));
			else if (req.query.resource)
				return sql.return(isMember(req.token.profile_id, req.query.resource_type === 'domains' ? req.query.resource : `${req.query.resource}.domain`));
			else
				throw new StatusError('at least one of "query.domain", "query.resource", or "query.role" must be provided', { status: 400 });
		},
		code: async (req, res) => {
			// Match conditions
			const match: any = {};
			if (req.query.domain)
				match.domain = req.query.domain;
			if (req.query.resource)
				match.resource = req.query.resource;
			if (req.query.role)
				match.role = req.query.role;

			// Domain
			const domain = req.query.domain || req.query.resource && req.query.resource_type === 'domains' ? req.query.resource : `${req.query.role || req.query.resource}.domain`;

			// List of ops
			const results = await query<AclEntry[]>(
				sql.multi([
					sql.let('$member', getMember(req.token.profile_id, domain as string)),

					sql.select<AclEntry>([
						'domain',
						'resource',
						'role',
						'permissions',
					], {
						from: 'acl',
						where: `${sql.match(match)} && ${canViewAcl('resource', 'role')}`,
					}),
				]),
				{ log: req.log }
			);
			assert(results);

			return results;
		},
	},

	"PATCH /permissions": {
		validate: {
			domain: {
				required: true,
				location: 'body',
				transform: (value) => isRecord(value, 'domains'),
			},
			permissions: {
				required: true,
				location: 'body',
				transform: (value) => isArray(value, (value) => {
					if (typeof value !== 'object' || typeof value.role !== 'string' || typeof value.resource !== 'string')
						throw new Error('must be a permissions object with a string `resource` and `role` field');
					if (!Array.isArray(value.permissions))
						throw new Error('`permissions` must be a string array');

					for (const perm of value.permissions) {
						if (typeof perm !== 'string')
							throw new Error('`permissions` must be a string array');
					}

					return value;
				}),
			},
		},
		// Must have modify access to all acl entries
		permissions: (req) => sql.multi([
			sql.let('$member', getMember(req.token.profile_id, req.body.domain)),
			sql.return(`array::all((SELECT VALUE ${canModifyAcl('resource', 'role', 'permissions')} FROM [${req.body.permissions.map(x => `{resource: ${x.resource}, role: ${x.role}, permissions: ${JSON.stringify(x.permissions)}}`).join(',')}]))`),
		]),
		code: async (req, res) => {
			const ops: string[] = [];

			// List of updated indices, and deleted entries
			const updateIndices: number[] = [];
			const deleted = req.body.permissions.filter(x => x.permissions.length === 0).map(x => ({ ...x, domain: req.body.domain }));

			for (const entry of req.body.permissions) {
				if (entry.permissions.length > 0) {
					// Upsert
					ops.push(
						sql.if({
							cond: `$entries CONTAINS "${entry.resource}.${entry.role}"`,
							body: sql.update<AclEntry>('acl', {
								set: { permissions: entry.permissions },
								where: sql.match<AclEntry>({ resource: entry.resource, role: entry.role }),
								return: 'AFTER',
							}),
						}, {
							body: sql.create<AclEntry>('acl', {
								...entry,
								domain: req.body.domain,
							}),
						})
					);
					updateIndices.push(ops.length);
				}
				else {
					// Delete
					ops.push(sql.delete('acl', { where: sql.match<AclEntry>({ resource: entry.resource, role: entry.role }) }));
				}
			}

			// Add entries fetch
			if (updateIndices.length > 0) {
				ops.splice(0, 0, sql.let('$entries', sql.select<AclEntry>(['VALUE string::concat(resource, ".", role)'], {
					from: 'acl',
					where: updateIndices.map(i => {
						const entry = req.body.permissions[i - 1];
						return `(resource=${entry.resource}&&role=${entry.role})`;
					}).join('||'),
				})));
			}

			// Perform transaction
			const results = await query<(AclEntry | AclEntry[])[]>(sql.transaction(ops), { complete: true, log: req.log });
			assert(results && (results.length === req.body.permissions.length || results.length === req.body.permissions.length + 1));

			return {
				updated: updateIndices.map(i => Array.isArray(results[i]) ? (results[i] as AclEntry[])[0] : results[i] as AclEntry).map(x => ({ ...x, id: undefined })),
				deleted,
			};
		},
	},
};

export default routes;