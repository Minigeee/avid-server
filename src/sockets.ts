import { Server as HttpServer } from 'http';

import { Server as SocketServer } from 'socket.io';

import config from './config';
import { getSessionUser } from './utility/auth';
import { getChannel } from './utility/db';
import { hasPermission, id, query, sql } from './utility/query';
import wrapper from './utility/wrapper';
import { log } from './logs';
import { Client, Socket } from './types';

import { Channel, ClientToServerEvents, Member, Profile, RemoteAppState, ServerToClientEvents } from '@app/types';

import { addChatHandlers } from './handlers/chat';
import assert from 'assert';


/** Websockets app */
let _socketServer: SocketServer<ClientToServerEvents, ServerToClientEvents>;

/** A map of profile ids to client objects */
const _clients: Record<string, Client> = {};


///////////////////////////////////////////////////////////
function _inactive(channel_id: string) {
	return `${channel_id}.inactive`;
}

////////////////////////////////////////////////////////////
function _recordKeys(map: Record<string, any> | undefined, table: string, transform?: (v: any) => any) {
	if (!map) return undefined;

	const newMap: Record<string, any> = {};
	for (const [k, v] of Object.entries(map))
		newMap[`${table}:${k}`] = transform ? transform(v) : v;
	return newMap;
}


///////////////////////////////////////////////////////////
export async function getUserInfo(profile_id: string) {
	const appId = `app_states:${profile_id.split(':')[1]}`;

	// Get member info
	const results = await query<[(Member & { out: string })[], RemoteAppState[]]>(sql.multi([
		sql.select<Member>(['out', 'roles'], { from: `${profile_id}->member_of` }),
		sql.select<RemoteAppState>(['domain', 'channels', 'seen'], { from: appId }),
	]), { complete: true });
	assert(results && results.length > 0);

	const members = results[0];

	// Create map
	const domains: Record<string, string[]> = {};
	for (const member of members)
		domains[member.out] = member.roles || [];

	// App state
	const state = results[1].length > 0 ? results[1][0] : null;

	return {
		domains,
		app: state ? {
			...state,
			channels: _recordKeys(state.channels, 'domains') || {},
			expansions: _recordKeys(state.expansions, 'domains') || {},
			seen: _recordKeys(state.seen, 'domains', (v) => _recordKeys(v, 'channels')) || {},
		} as RemoteAppState : null,
	};
}

/**
 * Set the channel seen value of a client locally and remotely.
 * It will perform the update based on the current domain and channel of the client.
 * Does nothing if there is no current domain or channel.
 * 
 * @param client The client to update
 * @param seen The new value to set
 */
export function setChannelSeen(client: Client, seen: boolean, remote: boolean = true) {
	// Mark new channel as seen
	if (client.current_domain && client.current_channel) {
		// Update locally
		if (!client.app.seen[client.current_domain])
			client.app.seen[client.current_domain] = {};
		client.app.seen[client.current_domain][client.current_channel] = seen;

		// Update database
		if (remote) {
			const id = `app_states:${client.profile_id.split(':')[1]}`;
			query(sql.update<RemoteAppState>(id, {
				content: {
					seen: {
						[client.current_domain]: { [client.current_channel]: seen },
					}
				},
				merge: true,
				return: 'NONE',
			}));
		}
	}
}


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
	_socketServer.on('connection', async (socket: Socket) => {
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
		const { domains, app } = await getUserInfo(profile_id);

		// Add socket data
		socket.data.profile_id = profile_id;

		// Create client object
		const client: Client = {
			profile_id,
			socket,
			domains,
			app: app || {
				domain: null,
				channels: {},
				expansions: {},
				seen: {},
				pings: {},
			},

			current_domain: app?.domain || '',
			current_channel: app?.channels?.[app?.domain || ''] || '',
		};
		_clients[profile_id] = client;

		// Join inactive type for all seen channels
		const inactive: string[] = [];
		for (const [channel_id, seen] of Object.entries(app?.seen[client.current_domain] || {})) {
			// Skip if the channel is the current
			if (channel_id === client.current_channel)
				continue;

			if (seen)
				inactive.push(_inactive(channel_id));
		}

		// Join inactive types for channels in the domain that are seen, and active for the current viewing channel
		socket.join(inactive);
		if (client.current_channel)
			socket.join(client.current_channel);

		// Join domain for domain specific updates (i.e. user join/leave)
		if (client.current_domain)
			socket.join(client.current_domain);


		// Mark profile as online
		query(sql.update<Profile>(profile_id, { set: { online: true } }));

		// Notify in every domain the user is in that they joined
		socket.to(Object.keys(domains)).emit('general:user-joined', profile_id);


		// Called when the socket disconnects for any reason
		socket.on('disconnect', wrapper.event((reason) => {
			// Mark profile as offline
			query(sql.update<Profile>(profile_id, { set: { online: false } }));

			// Notify in every domain the user is in that they left
			socket.to(Object.keys(domains)).emit('general:user-left', profile_id);

			// Remove client from map
			delete _clients[profile_id];

			// Logging
			log.info(`client disconnected`, { sender: profile_id });
		}, { client }));

		// Called when user switches the channel/domain they are viewing
		socket.on('general:switch-room', wrapper.event(async (domain_id: string, channel_id: string) => {
			if (!domain_id || !channel_id)
				throw new Error('must provide a domain and a channel');

			// Make sure user has permission to view channel
			const state_id = `app_states:${client.profile_id.split(':')[1]}`;
			const canView = await query<boolean>(sql.transaction([
				sql.let('$allowed', hasPermission(client.profile_id, channel_id, 'can_view', domain_id)),
				sql.if({
					cond: '$allowed = true',
					body: sql.update<RemoteAppState>(state_id, {
						content: {
							// Update values
							domain: domain_id,
							channels: { [id(domain_id)]: channel_id },
							// Update seen state
							seen: {
								[id(domain_id)]: { [id(channel_id)]: true },
							},
							// Reset pings
							pings: {
								[id(channel_id)]: 0,
							},
						},
						merge: true,
						return: 'NONE',
					}),
				}),
				sql.return('$allowed'),
			]));

			if (!canView)
				throw new Error('you do not have permission to view the requested channel');

			// Leave old domain and join new
			if (domain_id !== client.current_domain) {
				// Switch domain
				socket.leave(client.current_domain);
				socket.join(domain_id);

				// Switch active channel
				socket.leave(client.current_channel);
				socket.join(channel_id);

				// Leave all channels of old domain
				for (const channel_id of Object.keys(app?.seen[client.current_domain] || {}))
					socket.leave(_inactive(channel_id));

				// Join all seen channels of new domain
				const newInactive: string[] = [];
				for (const [id, seen] of Object.entries(app?.seen[client.current_domain] || {})) {
					// Skip if the channel is the current
					if (id === channel_id)
						continue;

					if (seen)
						newInactive.push(_inactive(id));
				}
				socket.join(newInactive);

				client.current_channel = channel_id;
				client.current_domain = domain_id;

				// Mark channel as seen
				setChannelSeen(client, true, false);
			}

			// Leave old channel and join new
			else if (channel_id !== client.current_channel) {
				// Switch active channel
				socket.leave(client.current_channel);
				socket.join(channel_id);

				// Leave inactive channel for new channel
				socket.leave(_inactive(channel_id));
				// Join inactive for the old channel
				socket.join(_inactive(client.current_channel));

				client.current_channel = channel_id;

				// Mark channel as seen
				setChannelSeen(client, true, false);
			}
		}));

		// Add message handlers
		addChatHandlers(client);


		// Join logging
		log.info(`new connection`, { sender: profile_id });
	});
}

///////////////////////////////////////////////////////////
export function io() { return _socketServer; }

///////////////////////////////////////////////////////////
export function clients() { return _clients; }


/**
 * Get socket client for a user, but returns io as back up
 * 
 * @param profile_id The id of the user
 * @returns The a socket
 */
export function getClientSocketOrIo(profile_id: string | undefined) {
	return profile_id ? _clients[profile_id]?.socket || _socketServer : _socketServer;
}


/** Channel emit options */
type ChannelEmitOptions = {
	/** The profile id of the user that is emitting the event (used to exclude the sender from recieving the event) */
	profile_id?: string;
	/** Determines if this channel should be marked as 'unseen' for users not viewing the channel (default: true) */
	mark_unseen?: boolean;
	/** Metadata that gets passed to activity event */
	activity_data?: any;
};

/**
 * Emit an event as a channel event. A channel event will
 * broadcast a full event with all event data to clients that are
 * actively viewing the specified channel. All clients that have access
 * to view the channel and have seen all latest channel events will be broadcasted
 * a generic `activity` event, notifying them that their data for the specified
 * channel is stale. For all clients that have access to view the channel, but
 * have not seen all the latest channel events, no event will be broadcasted to them
 * as they already know that their channel data is stale.
 * 
 * @param channel_id The channel the event is being broadcasted to
 * @param emitter The function used to emit the full event
 * @param options Emit options
 */
export async function emitChannelEvent(channel_id: string, emitter: (room: ReturnType<Socket['to']>, channel: Channel) => void | Promise<void>, options?: ChannelEmitOptions) {
	// Get socket to emit
	const socket = getClientSocketOrIo(options?.profile_id);

	// Get channel object to get domain
	const channel = await getChannel(channel_id);

	// Emit the activity event to inactive channel
	socket.to(_inactive(channel_id)).emit('general:activity', channel.domain, channel_id, options?.mark_unseen !== false);
	// Emit the event to active channel
	await emitter(socket.to(channel_id), channel);

	// Code to mark channel as unseen
	if (options?.mark_unseen !== false) {
		// Remove all clients from inactive channel, then mark all as unseen
		const sockets = await _socketServer.in(_inactive(channel_id)).fetchSockets();
		const state_ids = sockets.map((s) => `app_states:${s.data.profile_id.split(':')[1]}`) as string[];

		// Update locally
		for (const socket of sockets) {
			const profile_id = socket.data.profile_id;
			const client = _clients[profile_id];
			if (!client) continue;

			if (!client.app.seen[channel.domain])
				client.app.seen[channel.domain] = {};
			client.app.seen[channel.domain][channel_id] = false;
		}

		// Update database
		if (state_ids.length > 0) {
			query(sql.update<RemoteAppState>(state_ids, {
				content: {
					seen: {
						[id(channel.domain)]: {
							[id(channel_id)]: false
						}
					}
				},
				merge: true,
				return: 'NONE',
			}));
		}

		// Make all clients leave the inactive channel room
		_socketServer.socketsLeave(_inactive(channel_id));
	}
}