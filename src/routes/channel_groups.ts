import assert from 'assert';

import { AclEntry, AllPermissions, ChannelGroup, Domain } from '@app/types';

import {
  getMember,
  hasPermission,
  hasPermissionUsingMember,
  isMember,
  new_Record,
  query,
  sql,
} from '../utility/query';
import { ApiRoutes } from '../utility/routes';
import { asRecord, isRecord } from '../utility/validate';
import { getClientSocketOrIo } from '../sockets';

/** Default permissions for a new group for everyone */
export const DEFAULT_GROUP_PERMISSIONS = [
  'can_view',
  'can_send_messages',
  'can_send_attachments',
  'can_manage_extensions',
  'can_broadcast_audio',
  'can_broadcast_video',
] as AllPermissions[];

const routes: ApiRoutes<`${string} /channel_groups${string}`> = {
  'GET /channel_groups': {
    validate: {
      domain: {
        required: true,
        location: 'query',
        transform: (value) => asRecord('domains', value),
      },
    },
    permissions: (req) =>
      sql.return(isMember(req.token.profile_id, req.query.domain)),
    code: async (req, res) => {
      const results = await query<ChannelGroup[]>(
        sql.multi([
          sql.let('$member', getMember(req.token.profile_id, req.query.domain)),
          sql.select<ChannelGroup>('*', {
            from: 'channel_groups',
            where: `${sql.match({
              domain: req.query.domain,
            })} && ${hasPermissionUsingMember('id', 'can_view')}`,
          }),
        ]),
        { log: req.log },
      );
      assert(results);

      return results;
    },
  },

  'POST /channel_groups': {
    validate: {
      domain: {
        required: true,
        location: 'body',
        transform: (value) => isRecord(value, 'domains'),
      },
      name: {
        required: false,
        location: 'body',
      },
      allow_everyone: {
        required: false,
        location: 'body',
      },
    },
    permissions: (req) =>
      sql.return(
        hasPermission(
          req.token.profile_id,
          req.body.domain,
          'can_create_groups',
          req.body.domain,
        ),
      ),
    code: async (req, res) => {
      // List of operations
      const ops = [
        sql.let(
          '$group',
          sql.create<ChannelGroup>(
            'channel_groups',
            {
              domain: req.body.domain,
              name: req.body.name,
              channels: [],
            },
            { single: true },
          ),
        ),
        sql.return('$group'),
      ];

      // Add entry list
      if (req.body.allow_everyone) {
        ops.splice(
          1,
          0,
          sql.create<AclEntry>('acl', {
            domain: req.body.domain,
            resource: sql.$('$group.id'),
            role: sql.$(`${req.body.domain}._default_role`),
            permissions: DEFAULT_GROUP_PERMISSIONS,
          }),
        );
      }

      // Create group
      const results = await query<ChannelGroup>(sql.transaction(ops), {
        log: req.log,
      });
      assert(results);

      // Emit change
      const socket = getClientSocketOrIo(req.token.profile_id);
      socket.to(results.domain).emit('general:domain-update', results.domain, false);

      return results;
    },
  },

  'PATCH /channel_groups/:group_id': {
    validate: {
      group_id: {
        required: true,
        location: 'params',
        transform: (value) => asRecord('channel_groups', value),
      },
      name: {
        required: false,
        location: 'body',
      },
      after: {
        required: false,
        location: 'body',
        transform: (value) =>
          value === null ? null : isRecord(value, 'channel_groups'),
      },
    },
    permissions: (req) => {
      const ops = [];

      if (req.body.name !== undefined)
        ops.push(
          hasPermission(
            req.token.profile_id,
            req.params.group_id,
            'can_manage',
          ),
        );
      if (req.body.after !== undefined)
        ops.push(
          hasPermission(
            req.token.profile_id,
            `${req.params.group_id}.domain`,
            'can_manage',
            `${req.params.group_id}.domain`,
          ),
        );

      return sql.return(ops.join('&&'));
    },
    code: async (req, res) => {
      const ops: string[] = [];

      // Change group order
      if (req.body.after !== undefined) {
        const group_id = req.params.group_id.split(':')[1];
        const before = req.body.after;

        ops.push(
          sql.update<Domain>(`(${req.params.group_id}.domain)`, {
            set: {
              groups: sql.fn<Domain>(
                function () {
                  const targetRecord = `channel_groups:${group_id}`;

                  const from = this.groups.findIndex(
                    (x) => x.toString() === targetRecord,
                  );
                  const to = before
                    ? this.groups.findIndex((x) => x.toString() === before) + 1
                    : 0;

                  if (from >= 0) this.groups.splice(from, 1);
                  this.groups.splice(
                    to,
                    0,
                    new_Record('channel_groups', group_id),
                  );

                  return this.groups;
                },
                { before, group_id },
              ),
            },
            return: ['groups'],
          }),
        );
      }

      // Group update
      const groupUpdate = req.body.name !== undefined;
      if (groupUpdate)
        ops.push(
          sql.update<ChannelGroup>(req.params.group_id, {
            set: { name: req.body.name },
          }),
        );

      // Quit if no updates
      if (!ops.length) return null;

      // Execute query
      const results = await query<ChannelGroup[]>(sql.transaction(ops), {
        log: req.log,
      });
      assert(results);

      // Emit change
      if (groupUpdate && results.length > 0) {
        const socket = getClientSocketOrIo(req.token.profile_id);
        socket
          .to(results[0].domain)
          .emit('general:domain-update', results[0].domain, false);
      }

      return groupUpdate ? results[0] : null;
    },
  },

  'DELETE /channel_groups/:group_id': {
    validate: {
      group_id: {
        required: true,
        location: 'params',
        transform: (value) => asRecord('channel_groups', value),
      },
    },
    permissions: (req) =>
      sql.return(
        hasPermission(
          req.token.profile_id,
          req.params.group_id,
          'can_delete_group',
        ),
      ),
    code: async (req, res) => {
      const result = await query<ChannelGroup>(
        sql.delete<ChannelGroup>(req.params.group_id, {
          return: 'BEFORE',
          single: true,
        }),
        { log: req.log },
      );
      assert(result);

      // Emit change
      const socket = getClientSocketOrIo(req.token.profile_id);
      socket.to(result.domain).emit('general:domain-update', result.domain, true);
    },
  },
};

export default routes;
