import assert from 'assert';

import { Reaction } from '@app/types';
import { emitBatchEvent } from '@/utility/batcher';
import { hasPermission, query, sql } from '@/utility/query';
import { ApiRoutes } from '@/utility/routes';
import { asRecord, isRecord } from '@/utility/validate';
import { getChannel } from '@/utility/db';
import { io } from '@/sockets';


const routes: ApiRoutes<`${string} /reactions${string}`> = {
	"POST /reactions": {
		validate: {
			message: {
				required: true,
				location: 'body',
				transform: (value) => isRecord(value, 'messages'),
			},
			emoji: {
				required: true,
				location: 'body',
			},
		},
		permissions: (req) => sql.return(hasPermission(req.token.profile_id, `${req.body.message}.channel`, 'can_send_reactions')),
		code: async (req, res) => {
			// Create reaction
			const channel = await query<string>(sql.multi([
				sql.relate<{ emoji: string }>(req.token.profile_id, 'reactions', req.body.message, {
					content: { emoji: req.body.emoji },
				}),
				sql.return(`${req.body.message}.channel`),
			]), { log: req.log });
			assert(channel && typeof channel === 'string');

			// WIP : Maintain order reactions are added

			// TODO : Broadcast system
			emitBatchEvent('chat:reactions', req.body.message, channel, req.body.message, req.body.emoji, 1);
		},
	},

	"DELETE /reactions": {
		validate: {
			message: {
				required: true,
				location: 'query',
				transform: (value) => asRecord('messages', value),
			},
			member: {
				required: false,
				location: 'query',
				transform: (value) => asRecord('profiles', value),
			},
			emoji: {
				required: false,
				location: 'query',
			},
		},
		permissions: (req) => sql.return(`${req.query.member ? `${req.token.profile_id} == ${req.query.member} || ` : ''}${hasPermission(req.token.profile_id, `${req.query.message}.channel`, 'can_manage_messages')}`),
		code: async (req, res) => {
			// Delete conditions
			const conds: Record<string, string> = {};
			if (req.query.member)
				conds['in'] = req.query.member;
			if (req.query.emoji)
				conds['emoji'] = req.query.emoji;

			// Create reaction
			const results = await query<[Reaction[], string]>(sql.multi([
				sql.delete(`${req.query.message}<-reactions`, {
					where: Object.keys(conds).length > 0 ? sql.match(conds) : undefined,
					return: req.query.member || req.query.emoji ? 'BEFORE' : undefined,
				}),
				sql.return(`${req.query.message}.channel`),
			]), { complete: true, log: req.log });
			assert(results && results.length > 0);

			// TODO : Broadcast system
			if (req.query.emoji)
				emitBatchEvent('chat:reactions', req.query.message, results[1], req.query.message, req.query.emoji, -1 * (results[0]?.length || 0));
			else if (req.query.member) {
				for (const r of results[0] || [])
					emitBatchEvent('chat:reactions', req.query.message, results[1], req.query.message, r.emoji, -1);
			}
			else {
				// Remove all reactions from message
				await getChannel(results[1]).then(channel => {
					io().to(channel.domain).emit('chat:reactions', results[1], req.query.message, {}, true);
				});
			}
		},
	},
};

export default routes;