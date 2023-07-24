import { Server as HttpServer } from 'http';

import { Server as SocketServer } from 'socket.io';

import config from './config';
import { getDomainsOfUser } from './utility/db';
import { getSessionUser } from './utility/auth';
import { query, sql } from './utility/query';
import wrapper from './utility/wrapper';
import { log } from './logs';
import { Client } from './types';

import { ClientToServerEvents, Profile, ServerToClientEvents } from '@app/types';

import { addChatHandlers } from './handlers/chat';


/** Websockets app */
let _socketServer: SocketServer<ClientToServerEvents, ServerToClientEvents>;

/** A map of profile ids to client objects */
const _clients: Record<string, Client> = {};


///////////////////////////////////////////////////////////
export async function makeSocketServer(server: HttpServer) {
	// Create socket.io server
	_socketServer = new SocketServer(server, {
		cors: {
			origin: config.domains.cors,
			methods: ['GET', 'POST'],
		}
	});

	// Handle client connect
	_socketServer.on('connection', async (socket) => {
		// Parse headers to get identity
		const user = getSessionUser(socket.handshake.auth.token);
		if (!user?.profile_id) {
			log.warn('not authenticated');
			socket.emit('error', 'not authenticated', 401);
			socket.disconnect();
			return;
		}

		// Get user info
		const profile_id = user.profile_id;
		const domains = await getDomainsOfUser(profile_id);

		// Create client object
		const client: Client = {
			profile_id,
			socket,
			domains,

			current_domain: '',
		};
		_clients[profile_id] = client;

		// TODO : Performance optimization - only send messages to domain if the user is viewing it or there are no other unseen events in that domain
		// Add client to all domain rooms
		socket.join(Object.keys(domains));


		// Mark profile as online
		console.log(sql.update<Profile>(profile_id, { set: { online: true } }))
		query(sql.update<Profile>(profile_id, { set: { online: true } }));

		// Notify in every domain the user is in that they joined
		socket.to(Object.keys(domains)).emit('general:user-joined', profile_id);


		// Called when the socket disconnects for any reason
		socket.on('disconnect', wrapper.event((reason) => {
			// Mark profile as offline
			// TODO : query(sql.update<Profile>(profile_id, { set: { online: false } }));

			// Notify in every domain the user is in that they left
			socket.to(Object.keys(domains)).emit('general:user-left', profile_id);

			// Remove client from map
			delete _clients[profile_id];

			// Logging
			log.info(`client disconnected`, { sender: profile_id });
		}, { client }));

		// Add message handlers
		addChatHandlers(client);


		// Join logging
		log.info(`new connection`, { sender: profile_id });
	});
}

///////////////////////////////////////////////////////////
export function io() { return _socketServer; }


/**
 * Get socket client for a user, but returns io as back up
 * 
 * @param profile_id The id of the user
 * @returns The a socket
 */
export function getClientSocketOrIo(profile_id: string) {
	return _clients[profile_id]?.socket || _socketServer;
}