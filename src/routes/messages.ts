import assert from 'assert';

import {
  AggregatedReaction,
  Channel,
  ExpandedMember,
  Member,
  Message,
  PrivateMember,
  RawMessage,
  Thread,
} from '@app/types';

import config from '../config';
import { StatusError } from '../utility/error';
import { SqlContent, hasPermission, isPrivateMember, query, sql } from '../utility/query';
import { ApiRoutes } from '../utility/routes';
import {
  asBool,
  asInt,
  asRecord,
  isBool,
  isRecord,
  sanitizeHtml,
} from '../utility/validate';
import { emitChannelEvent, getClientSocketOrIo } from '../sockets';
import { ping } from '../utility/ping';
import { getChannel } from '../utility/db';
import { MEMBER_SELECT_FIELDS } from './members';

import { isNil, omitBy } from 'lodash';
import { PRIVATE_MEMBER_SELECT_FIELDS } from './private_channels';

/** Finds all mentions in message */
function findMentions(message: string) {
  const mtype = '{}';
  const rtype = '[]';

  // Map of mentions
  const mentions = {
    members: new Set<string>(),
    roles: new Set<string>(),
  };

  message.match(/@[\[\{]\w+[\]\}]/g)?.forEach((match) => {
    // Check ention type
    let type = match.at(1);
    if (type === mtype[0]) type = mtype[1];
    else if (type === rtype[0]) type = rtype[1];
    // Not a mention
    else return;

    // Check if closing bracket is correct
    if (match.at(-1) !== type) return;

    // Get id
    const id = match.substring(2, match.length - 1);

    if (type === mtype[1]) mentions.members.add(`profiles:${id}`);
    else if (type === rtype[1]) mentions.roles.add(`roles:${id}`);
  });

  return mentions;
}

const routes: ApiRoutes<`${string} /messages${string}`> = {
  'GET /messages': {
    validate: {
      channel: {
        required: true,
        location: 'query',
        transform: (value, req) =>
          typeof req.query.private === 'string' && req.query.private === 'true'
            ? asRecord('private_channels', value)
            : asRecord('channels', value),
      },
      thread: {
        required: false,
        location: 'query',
        transform: (value) => asRecord('threads', value),
      },
      pinned: {
        required: false,
        location: 'query',
        transform: (value) => asBool(value),
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
      private: {
        required: false,
        location: 'query',
        transform: asBool,
      },
    },
    permissions: (req) =>
      sql.return(
        req.query.private
          ? isPrivateMember(req.token.profile_id, req.query.channel)
          : hasPermission(req.token.profile_id, req.query.channel, 'can_view'),
      ),
    code: async (req, res) => {
      const limit = Math.min(
        req.query.limit || config.db.page_size.messages,
        1000,
      );

      // Message match condition
      const conds: Partial<Message> = { channel: req.query.channel };
      if (req.query.thread) conds.thread = req.query.thread;
      if (req.query.pinned) conds.pinned = true;

      // Get messages and reactions
      const results = await query<
        [
          unknown,
          unknown,
          unknown,
          (AggregatedReaction & { message: string })[],
          Member[],
          Thread[],
          (Omit<Message, 'reply_to'> & { reply_to?: Message })[],
        ]
      >(
        sql.multi([
          // Get messages
          sql.let(
            '$messages',
            sql.select<Message>('*', {
              from: 'messages',
              where: sql.match<Message>(conds),
              start:
                req.query.page !== undefined
                  ? req.query.page * limit
                  : undefined,
              limit: limit,
              sort: [{ field: 'created_at', order: 'DESC' }],
              fetch: ['reply_to'],
            }),
          ),
          // Unique list of sender ids
          sql.let(
            '$senders',
            'array::group([$messages.sender, array::flatten($messages.mentions.members), $messages.reply_to.sender, array::flatten($messages.reply_to.mentions.members)])',
          ),
          // Unique list of threads
          sql.let('$threads', 'array::distinct($messages.thread)'),
          // List of reactions
          sql.select(
            [
              'emoji',
              'count() AS count',
              `count(in == ${req.token.profile_id}) AS self`,
              'out AS message',
            ],
            {
              from: 'reactions',
              where: sql.match({ out: ['IN', sql.$('$messages.id')] }),
              group: ['emoji', 'message'],
            },
          ),
          // List of members (depends on if channel is private dm)
          req.query.private
            ? sql.select<PrivateMember>(PRIVATE_MEMBER_SELECT_FIELDS, {
                from: `${req.query.channel}<-private_member_of`,
              })
            : sql.select<Member>(MEMBER_SELECT_FIELDS, {
                from: `${req.query.channel}.domain<-member_of`,
                where: sql.match({ in: ['IN', sql.$('$senders')] }),
              }),
          // List of threads
          sql.select<Thread>('*', {
            from: 'threads',
            where: sql.match({ id: ['IN', sql.$('$threads')] }),
          }),
          sql.return('$messages'),
        ]),
        { complete: true, log: req.log },
      );
      assert(results && results.length > 0);

      const reactions = results[3];
      const members = results[4];
      const threads = results[5];
      const messages = results[6];

      // Map of members
      const memberMap: Record<string, Member> = {};
      for (const member of members)
        memberMap[member.id] = omitBy(
          { ...member, is_admin: member.is_admin || undefined },
          isNil,
        ) as ExpandedMember;

      // Map of threads
      const threadMap: Record<string, Thread> = {};
      for (const thread of threads) threadMap[thread.id] = thread;

      // Map of reactions lists
      const reactionsMap: Record<
        string,
        (AggregatedReaction & { message: undefined })[]
      > = {};
      for (const reaction of reactions.reverse()) {
        if (!reactionsMap[reaction.message])
          reactionsMap[reaction.message] = [];

        reactionsMap[reaction.message].push({
          ...reaction,
          message: undefined,
        });
      }

      // Sort reactions
      for (const reactions of Object.values(reactionsMap))
        reactions.sort((a, b) => b.count - a.count);

      return {
        messages: messages.map((x) => ({
          ...x,
          reactions: reactionsMap[x.id],
        })),
        members: memberMap,
        threads: threadMap,
      };
    },
  },

  'POST /messages': {
    validate: {
      channel: {
        required: true,
        location: 'body',
        transform: (value) => isRecord(value, ['channels', 'private_channels']),
      },
      message: {
        required: true,
        location: 'body',
      },
      attachments: {
        required: false,
        location: 'body',
      },
      reply_to: {
        required: false,
        location: 'body',
        transform: (value) => isRecord(value, 'messages'),
      },
      thread: {
        required: false,
        location: 'body',
        transform: (value) => isRecord(value, 'threads'),
      },
    },
    permissions: (req) =>
      sql.return(
        req.body.channel.startsWith('private_channels')
          ? isPrivateMember(req.token.profile_id, req.body.channel)
          : hasPermission(
              req.token.profile_id,
              req.body.channel,
              'can_send_messages',
            ),
      ),
    code: async (req, res) => {
      // Analyze message for pings
      const mentions = findMentions(req.body.message);

      // Operations
      let ops: string[] = [];
      // Thread value
      let thread: any = req.body.thread;

      // Check if thread logic is needed
      if (req.body.reply_to) {
        ops = [
          // Get message being replied to
          sql.let(
            '$reply_to',
            sql.select<Message>('*', {
              from: req.body.reply_to,
              single: true,
            }),
          ),
          // Get thread id
          sql.let(
            '$thread',
            sql.if(
              {
                cond: '$reply_to.thread != NONE',
                body: '$reply_to.thread',
              },
              {
                body: sql.create<Thread>(
                  'threads',
                  {
                    channel: req.body.channel,
                    name: sql.$('string::slice($reply_to.message, 0, 64)'),
                    starters: sql.$(
                      `[${req.token.profile_id}, $reply_to.sender]`,
                    ),
                  },
                  { single: true },
                ),
              },
            ),
          ),
          // Update replied to's thread value
          sql.if(
            {
              cond: '$reply_to.thread != $thread.id',
              body: sql.update<Message>(req.body.reply_to, {
                set: { thread: sql.$('$thread.id') },
              }),
            },
            {
              body: sql.update<Thread>('($reply_to.thread)', {
                set: { last_active: sql.$('time::now()') },
              }),
            },
          ),
          // Get replied to message
          sql.select('*', { from: '$reply_to' }),
        ];

        // Set thread
        thread = sql.$('$thread.id');
      }

      // If thread provieded, update latest activity
      if (req.body.thread) {
        ops.push(
          sql.update<Thread>(req.body.thread, {
            set: { last_active: sql.$('time::now()') },
          }),
        );
      }

      // Create message
      ops.push(
        sql.create<Message>('messages', {
          channel: req.body.channel,
          sender: req.token.profile_id,
          message: req.body.message,
          attachments: req.body.attachments,
          reply_to: req.body.reply_to,
          thread: thread,
          mentions:
            mentions.members.size > 0 || mentions.roles.size > 0
              ? {
                  members: Array.from(mentions.members),
                  roles: Array.from(mentions.roles),
                }
              : undefined,
        }),
      );

      // Post message
      const results = await query<Message[][]>(sql.transaction(ops), {
        complete: true,
        log: req.log,
      });
      assert(results && results.length > 0);

      // Attach reply to method
      const newMessage = (results.at(-1) as Message[])[0];
      const rawMessage = req.body.reply_to
        ? { ...newMessage, reply_to: (results.at(-2) as Message[])[0] }
        : (newMessage as RawMessage);

      // TODO : Send notis to people pinged

      // Broadcast message
      const sender_id = req.token.profile_id;
      if (!req.body.channel.startsWith('private_channels')) {
        // Normal channel
        emitChannelEvent(
          req.body.channel,
          async (room, channel) => {
            // Emit
            room.emit('chat:message', rawMessage);

            // Send ping
            await ping(channel.domain, channel.id, {
              member_ids: Array.from(mentions.members),
              role_ids: Array.from(mentions.roles),
              sender_id,
            });
          },
          { profile_id: req.token.profile_id },
        );
      } else {
        // Private channel, emit event normally
        const socket = getClientSocketOrIo(req.token.profile_id);
        socket.to(req.body.channel).emit('chat:message', rawMessage);

        // Send ping
        await ping(undefined, req.body.channel, {
          member_ids: Array.from(mentions.members),
          sender_id,
        });
      }

      return rawMessage;
    },
  },

  'PATCH /messages/:message_id': {
    validate: {
      message_id: {
        required: true,
        location: 'params',
        transform: (value) => asRecord('messages', value),
      },
      message: {
        required: false,
        location: 'body',
      },
      pinned: {
        required: false,
        location: 'body',
        transform: isBool,
      },
      private: {
        required: false,
        location: 'body',
        transform: isBool,
      },
    },
    // Only sender can edit their own message
    permissions: (req) => {
      const conds: string[] = [];

      if (req.body.message !== undefined)
        conds.push(
          `${req.params.message_id}.sender == ${req.token.profile_id}`,
        );
      if (req.body.pinned !== undefined)
        conds.push(
          req.body.private
            ? isPrivateMember(
                req.token.profile_id,
                `${req.params.message_id}.channel`,
              )
            : hasPermission(
                req.token.profile_id,
                `${req.params.message_id}.channel`,
                'can_manage_messages',
              ),
        );

      // Error if no changes
      if (conds.length === 0)
        throw new StatusError('must update a message value', { status: 400 });

      return sql.return(conds.join(' && '));
    },
    code: async (req, res) => {
      const updated: SqlContent<Message> = {};

      // Handle message change
      if (req.body.message !== undefined) {
        // Analyze message for pings
        const mentions = findMentions(req.body.message);

        // New message fields
        updated.message = req.body.message;
        updated.mentions =
          mentions.members.size > 0 || mentions.roles.size > 0
            ? {
                members: Array.from(mentions.members),
                roles: Array.from(mentions.roles),
              }
            : undefined;
        updated.edited = true;
      }

      // Pin message
      if (req.body.pinned !== undefined) {
        updated.pinned = req.body.pinned !== false;
      }

      // Quit early if no changes
      if (Object.keys(updated).length === 0)
        throw new StatusError('must update a message value', { status: 400 });

      // Perform query
      const results = await query<Message[]>(
        sql.update<Message>(req.params.message_id, {
          set: updated,
          return: ['channel', 'message', 'pinned', 'edited', 'mentions'],
        }),
        { log: req.log },
      );
      assert(results && results.length > 0);

      // Broadcast edit message
      {
        const message = results[0];
        const { message_id } = req.params;

        if (!req.body.private) {
          emitChannelEvent(
            message.channel,
            (room) => {
              room.emit(
                'chat:edit-message',
                message.channel,
                message_id,
                message,
              );
            },
            { profile_id: req.token.profile_id, is_event: false },
          );
        } else {
          // Private channel, emit event normally
          const socket = getClientSocketOrIo(req.token.profile_id);
          socket
            .to(message.channel)
            .emit('chat:edit-message', message.channel, message_id, message);
        }
      }

      return { message: results[0].message };
    },
  },

  'DELETE /messages/:message_id': {
    validate: {
      message_id: {
        required: true,
        location: 'params',
        transform: (value) => asRecord('messages', value),
      },
      private: {
        required: false,
        location: 'query',
        transform: asBool,
      },
    },
    // Can delete message if it is sender's message, or if user has permission to delete messages
    permissions: (req) =>
      sql.return(
        `${req.params.message_id}.sender == ${req.token.profile_id} || ${
          req.query.private
            ? isPrivateMember(
                req.token.profile_id,
                `${req.params.message_id}.channel`,
              )
            : hasPermission(
                req.token.profile_id,
                `${req.params.message_id}.channel`,
                'can_manage_messages',
              )
        }`,
      ),
    code: async (req, res) => {
      const results = await query<Message[]>(
        sql.delete(req.params.message_id, { return: 'BEFORE' }),
        { log: req.log },
      );
      assert(results && results.length > 0);

      // Broadcast deletion
      {
        const channel_id = results[0].channel;
        const { message_id } = req.params;

        if (!req.query.private) {
          emitChannelEvent(
            channel_id,
            (room) => {
              room.emit('chat:delete-message', channel_id, message_id);
            },
            { profile_id: req.token.profile_id, is_event: false },
          );
        } else {
          // Private channel, emit event normally
          const socket = getClientSocketOrIo(req.token.profile_id);
          socket
            .to(channel_id)
            .emit('chat:delete-message', channel_id, message_id);
        }
      }
    },
  },
};

export default routes;
