import assert from 'assert';

import {
  Board,
  Channel,
  ChannelGroup,
  ChannelOptions,
  ChannelTypes,
  ExpandedPrivateChannel,
  ExpandedPrivateMember,
  PrivateChannel,
  PrivateMember,
} from '@app/types';

import config from '../config';
import {
  getMember,
  hasPermission,
  hasPermissionUsingMember,
  isMember,
  isPrivateMember,
  isPrivateOwner,
  new_Record,
  query,
  sql,
} from '../utility/query';
import { ApiRoutes } from '../utility/routes';
import { asRecord, isArray, isBool, isIn, isRecord } from '../utility/validate';

import { pick } from 'lodash';

/** Fields that get selected */
export const PRIVATE_MEMBER_SELECT_FIELDS = [
  'in AS id',
  'is_owner',
  'time_joined',
  'in.username AS alias',
  'in.profile_picture AS profile_picture',
  'in.online AS online',
];

const routes: ApiRoutes<`${string} /private_channels${string}`> = {
  'GET /private_channels': {
    validate: {},
    code: async (req, res) => {
      // Get all private channels the user is part of
      const results = await query<ExpandedPrivateChannel[]>(
        sql.select<PrivateChannel>(['*', '<-private_member_of.in AS members'], {
          from: `${req.token.profile_id}->private_member_of->private_channels`,
          sort: [{ field: '_last_event', order: 'DESC' }],
        }),
        {
          log: req.log,
        },
      );
      assert(results);

      // Detect no private channels
      if (results.length === 1 && results[0].members === null) return [];

      return results;
    },
  },

  'POST /private_channels': {
    validate: {
      members: {
        location: 'body',
        required: false,
        transform: (value) =>
          isArray(value, (elem) => isRecord(elem, 'profiles')),
      },
      multi_member: {
        location: 'body',
        required: false,
        transform: isBool,
      },
      name: {
        location: 'body',
        required: false,
      },
    },
    // TODO : Limit number of private channels, add blocking feature where profiles can block each other from being dm'd
    // TODO : Limit number of members
    code: async (req, res) => {
      // List of operations
      const ops = [
        // Create channel
        sql.let(
          '$channel',
          sql.create<PrivateChannel>(
            'private_channels',
            {
              name: req.body.name,
              multi_member: req.body.multi_member || false,
            },
            { single: true },
          ),
        ),

        // Add self as member
        sql.relate<PrivateMember>(
          req.token.profile_id,
          'private_member_of',
          '$channel.id',
          {
            content: { is_owner: true },
            single: true,
            return: ['in AS id'],
          },
        ),
      ];

      // Add relations if needed
      if (req.body.members?.length) {
        for (const profile_id of req.body.members)
          ops.push(
            sql.relate<PrivateMember>(
              profile_id,
              'private_member_of',
              '$channel.id',
              { single: true, return: ['in AS id'] },
            ),
          );
      }

      // Return channel object
      ops.push('$channel');

      // Perform trransaction
      const results = await query<({ id: string } | PrivateChannel)[]>(
        sql.transaction(ops),
        {
          complete: true,
          log: req.log,
        },
      );
      assert(results);

      // Construct channel
      const channel = results.at(-1) as PrivateChannel;
      return {
        ...channel,
        members: results.slice(1, -1).map(x => x.id),
      };
    },
  },

  'PATCH /private_channels/:channel_id': {
    validate: {
      channel_id: {
        location: 'params',
        required: true,
        transform: (value) => asRecord('private_channels', value),
      },
      name: {
        location: 'body',
        required: true,
      },
    },
    // Make sure the user is a member of the private channel
    permissions: (req) =>
      sql.return(isPrivateMember(req.token.profile_id, req.params.channel_id)),
    code: async (req, res) => {
      // Change name
      const result = await query<PrivateChannel>(
        sql.update<PrivateChannel>(req.params.channel_id, {
          set: { name: req.body.name },
          single: true,
        }),
        {
          log: req.log,
        },
      );
      assert(result);

      return result;
    },
  },

  'GET /private_channels/:channel_id/members': {
    validate: {
      channel_id: {
        location: 'params',
        required: true,
        transform: (value) => asRecord('private_channels', value),
      },
    },
    // Make sure the user is a member of the private channel
    permissions: (req) =>
      sql.return(isPrivateMember(req.token.profile_id, req.params.channel_id)),
    code: async (req, res) => {
      // Change name
      const results = await query<ExpandedPrivateMember[]>(
        sql.select<ExpandedPrivateMember>(PRIVATE_MEMBER_SELECT_FIELDS, {
          from: `${req.params.channel_id}<-private_member_of`,
          sort: [{ field: 'alias', mode: 'COLLATE' }],
        }),
        {
          log: req.log,
        },
      );
      assert(results);

      return results;
    },
  },

  'POST /private_channels/:channel_id/members': {
    validate: {
      channel_id: {
        location: 'params',
        required: true,
        transform: (value) => asRecord('private_channels', value),
      },
      members: {
        location: 'body',
        required: true,
        transform: (value) =>
          isArray(value, (elem) => isRecord(elem, 'profiles')),
      },
    },
    // TODO : Limit number of members
    // Make sure the channel allows multi member and the user is a member of the private channel
    permissions: (req) =>
      sql.return(
        `${req.params.channel_id}.multi_member == true && ${isPrivateMember(
          req.token.profile_id,
          req.params.channel_id,
        )}`,
      ),
    code: async (req, res) => {
      const ops: string[] = [];

      // Add members
      for (const profile_id of req.body.members)
        ops.push(
          sql.relate<PrivateMember>(
            profile_id,
            'private_member_of',
            req.params.channel_id,
          ),
        );

      // Select all new members
      ops.push(
        sql.select<ExpandedPrivateMember>(PRIVATE_MEMBER_SELECT_FIELDS, {
          from: `${req.params.channel_id}<-private_member_of`,
          sort: [{ field: 'alias', mode: 'COLLATE' }],
        }),
      );

      // Perform transaction
      const results = await query<ExpandedPrivateMember[]>(
        sql.transaction(ops),
        {
          log: req.log,
        },
      );
      assert(results);

      return results;
    },
  },

  'DELETE /private_channels/:channel_id/members/:member_id': {
    validate: {
      channel_id: {
        location: 'params',
        required: true,
        transform: (value) => asRecord('private_channels', value),
      },
      member_id: {
        location: 'params',
        required: true,
        transform: (value) => asRecord('profiles', value),
      },
    },
    // Make sure the channel allows multi member and the user is the owner of the private channel
    permissions: (req) =>
      sql.return(
        `${req.params.channel_id}.multi_member == true && ${isPrivateOwner(
          req.token.profile_id,
          req.params.channel_id,
        )}`,
      ),
    code: async (req, res) => {
      // Remove member from channel
      await query(
        sql.delete(`${req.params.channel_id}<-private_member_of`, {
          where: sql.match({ in: req.params.member_id }),
          return: 'NONE',
        }),
        {
          log: req.log,
        },
      );
    },
  },
};

export default routes;
