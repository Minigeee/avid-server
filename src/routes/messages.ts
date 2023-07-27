import assert from 'assert';

import { AggregatedReaction, Channel, ExpandedMember, Member, Message, Thread } from '@app/types';

import config from '../config';
import { hasPermission, query, sql } from '../utility/query';
import { ApiRoutes } from '../utility/routes';
import { asInt, asRecord, isRecord, sanitizeHtml } from '../utility/validate';
import { getClientSocketOrIo } from '../sockets';
import { getChannel } from '../utility/db';
import { MEMBER_SELECT_FIELDS } from './members';

import { isNil, omitBy } from 'lodash';


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
		if (type === mtype[0])
			type = mtype[1];
		else if (type === rtype[0])
			type = rtype[1];
		else
			// Not a mention
			return;

		// Check if closing bracket is correct
		if (match.at(-1) !== type) return;

		// Get id
		const id = match.substring(2, match.length - 1);

		if (type === mtype[1])
			mentions.members.add(`profiles:${id}`);
		else if (type === rtype[1])
			mentions.roles.add(`roles:${id}`);
	});

	return mentions;
}


const routes: ApiRoutes<`${string} /messages${string}`> = {
	"GET /messages": {
		validate: {
			channel: {
				required: true,
				location: 'query',
				transform: (value) => asRecord('channels', value),
			},
			thread: {
				required: false,
				location: 'query',
				transform: (value) => asRecord('threads', value),
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
		},
		permissions: (req) => sql.return(hasPermission(req.token.profile_id, req.query.channel, 'can_view')),
		code: async (req, res) => {
			const limit = Math.min(req.query.limit || config.db.page_size.messages, 1000);

			// Message match condition
			const conds: Partial<Record<keyof Message, string>> = { channel: req.query.channel };
			if (req.query.thread)
				conds.thread = req.query.thread;

			// Get messages and reactions
			const results = await query<[unknown, unknown, (AggregatedReaction & { message: string })[], Member[], Message[]]>(sql.multi([
				// Get messages
				sql.let('$messages', sql.select<Message>('*', {
					from: 'messages',
					where: sql.match<Message>(conds),
					start: req.query.page !== undefined ? req.query.page * limit : undefined,
					limit: limit,
					sort: [{ field: 'created_at', order: 'DESC' }],
				})),
				// Unique list of sender ids
				sql.let('$senders', 'array::group([$messages.sender, array::flatten($messages.mentions.members)])'),
				// List of reactions
				sql.select(['emoji', 'count() AS count', `count(in == ${req.token.profile_id}) AS self`, 'out AS message'], {
					from: 'reactions',
					where: sql.match({ out: ['IN', sql.$('$messages.id')] }),
					group: ['emoji', 'message'],
				}),
				// List of members
				sql.select<Member>(MEMBER_SELECT_FIELDS, {
					from: `${req.query.channel}.domain<-member_of`,
					where: sql.match({ in: ['IN', sql.$('$senders')] }),
				}),
				sql.return('$messages'),

			]), { complete: true, log: req.log });
			assert(results && results.length > 0);

			const reactions = results[2];
			const members = results[3];
			const messages = results[4];

			// Map of members
			const memberMap: Record<string, Member> = {};
			for (const member of members)
				memberMap[member.id] = omitBy({ ...member, is_admin: member.is_admin || undefined }, isNil) as ExpandedMember;

			// Map of reactions lists
			const reactionsMap: Record<string, (AggregatedReaction & { message: undefined })[]> = {};
			for (const reaction of reactions.reverse()) {
				if (!reactionsMap[reaction.message])
					reactionsMap[reaction.message] = [];

				reactionsMap[reaction.message].push({ ...reaction, message: undefined });
			}

			// Sort reactions
			for (const reactions of Object.values(reactionsMap))
				reactions.sort((a, b) => b.count - a.count);

			return {
				messages: messages.map(x => ({ ...x, reactions: reactionsMap[x.id] })),
				members: memberMap,
			};
		},
	},

	"POST /messages": {
		validate: {
			channel: {
				required: true,
				location: 'body',
				transform: (value) => isRecord(value, 'channels'),
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
		permissions: (req) => sql.return(hasPermission(req.token.profile_id, req.body.channel, 'can_send_messages')),
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
					sql.let('$reply_to', sql.select<Message>(['thread', 'message', 'sender'], { from: req.body.reply_to })),
					// Get thread id
					sql.let('$thread', sql.if({
						cond: '$reply_to.thread != NONE',
						body: '$reply_to.thread',
					}, {
						body: sql.create<Thread>('threads', {
							channel: req.body.channel,
							name: sql.$('string::slice($reply_to.message, 0, 64)'),
							starters: sql.$(`[${req.token.profile_id}, $reply_to.sender]`),
						}, ['id']),
					})),
					// Update replied to's thread value
					sql.if({
						cond: '$reply_to.thread != $thread.id',
						body: sql.update<Message>(req.body.reply_to, { set: { thread: sql.$('$thread.id') } }),
					}, {
						body: sql.update<Thread>('($reply_to.thread)', { set: { last_active: sql.$('time::now()') } }),
					}),
				];

				// Set thread
				thread = sql.$('$thread.id');
			}

			// If thread provieded, update latest activity
			if (req.body.thread) {
				ops.push(
					sql.update<Thread>(req.body.thread, { set: { last_active: sql.$('time::now()') } })
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
					mentions: mentions.members.size > 0 || mentions.roles.size > 0 ? {
						members: Array.from(mentions.members),
						roles: Array.from(mentions.roles),
					} : undefined,
				})
			);

			// Post message
			const results = await query<Message[]>(
				sql.transaction(ops),
				{ log: req.log }
			);
			assert(results && results.length > 0);

			// TODO : Send notis to people pinged

			// Broadcast message
			// TODO : Improve broadcast system
			await getChannel(req.body.channel).then(channel => {
				const socket = getClientSocketOrIo(req.token.profile_id);
				socket.to(channel.domain).emit('chat:message', channel.domain, results[0]);
			});

			return results[0];
		},
	},

	"PATCH /messages/:message_id": {
		validate: {
			message_id: {
				required: true,
				location: 'params',
				transform: (value) => asRecord('messages', value),
			},
			message: {
				required: true,
				location: 'body',
			}
		},
		// Only sender can edit their own message
		permissions: (req) => sql.return(`${req.params.message_id}.sender == ${req.token.profile_id}`),
		code: async (req, res) => {
			// Analyze message for pings
			const mentions = findMentions(req.body.message);

			const results = await query<Message[]>(
				sql.update<Message>(req.params.message_id, {
					set: {
						message: req.body.message,
						mentions: mentions.members.size > 0 || mentions.roles.size > 0 ? {
							members: Array.from(mentions.members),
							roles: Array.from(mentions.roles),
						} : undefined,
						edited: true,
					},
					return: ['channel', 'message'],
				}),
				{ log: req.log }
			);
			assert(results && results.length > 0);

			// Broadcast new message
			// TODO : Improve broadcast system
			await getChannel(results[0].channel).then(channel => {
				const socket = getClientSocketOrIo(req.token.profile_id);
				socket.to(channel.domain).emit('chat:edit-message', channel.domain, channel.id, req.params.message_id, results[0].message);
			});

			return { message: results[0].message };
		},
	},

	"DELETE /messages/:message_id": {
		validate: {
			message_id: {
				required: true,
				location: 'params',
				transform: (value) => asRecord('messages', value),
			},
		},
		// Can delete message if it is sender's message, or if user has permission to delete messages
		permissions: (req) => sql.return(`${req.params.message_id}.sender == ${req.token.profile_id} || ${hasPermission(req.token.profile_id, `${req.params.message_id}.channel`, 'can_manage_messages')}`),
		code: async (req, res) => {
			const results = await query<Message[]>(
				sql.delete(req.params.message_id, { return: 'BEFORE' }),
				{ log: req.log }
			);
			assert(results && results.length > 0);

			// Broadcast deletion
			// TODO : Improve broadcast system
			await getChannel(results[0].channel).then(channel => {
				const socket = getClientSocketOrIo(req.token.profile_id);
				socket.to(channel.domain).emit('chat:delete-message', channel.domain, channel.id, req.params.message_id);
			});
		},
	},
};

export default routes;