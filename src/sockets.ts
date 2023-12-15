import { Server as HttpServer } from 'http';

import { Server as SocketServer } from 'socket.io';

import config from './config';
import { getSessionUser } from './utility/auth';
import {
  getChannel,
  getDomainChannels,
  getDomainChannelsCache,
} from './utility/db';
import { hasPermission, id, query, sql } from './utility/query';
import wrapper from './utility/wrapper';
import { log } from './logs';
import { Client, Socket } from './types';

import {
  Channel,
  ClientToServerEvents,
  DeepPartial,
  Member,
  Profile,
  RemoteAppState,
  ServerToClientEvents,
} from '@app/types';

import { addChatHandlers } from './handlers/chat';
import { addRtcHandlers } from './handlers/rtc';
import { isBool, isRecord } from './utility/validate';

import assert from 'assert';
import { pick } from 'lodash';

/** Websockets app */
let _socketServer: SocketServer<ClientToServerEvents, ServerToClientEvents>;

/** A map of profile ids to client objects */
const _clients: Record<string, Client> = {};

////////////////////////////////////////////////////////////
function transformObject(
  value: any,
  transform: (k: string, v: any) => [string, any],
) {
  if (typeof value !== 'object') throw new Error(`must be an object`);

  for (const [k, v] of Object.entries(value)) {
    try {
      const entry = transform(k, v);
      if (k !== entry[0]) {
        delete value[k];
        value[entry[0]] = entry[1];
      } else if (v !== entry[1]) value[k] = entry[1];
    } catch (err: any) {
      throw new Error(`[${k}] ${err.message}`);
    }
  }

  return value;
}

///////////////////////////////////////////////////////////
function _inactive(channel_id: string) {
  return `${channel_id}.inactive`;
}

////////////////////////////////////////////////////////////
function _recordKeys(
  map: Record<string, any> | undefined,
  table: string,
  transform?: (v: any) => any,
) {
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
  const results = await query<[(Member & { out: string })[], RemoteAppState[]]>(
    sql.multi([
      sql.select<Member>(['out', 'roles'], {
        from: `${profile_id}->member_of`,
      }),
      sql.select<RemoteAppState>(['domain', 'channels', 'last_accessed'], {
        from: appId,
      }),
    ]),
    { complete: true },
  );
  assert(results && results.length > 0);

  const members = results[0];

  // Create map
  const domains: Record<string, string[]> = {};
  for (const member of members) domains[member.out] = member.roles || [];

  // App state
  const state = results[1].length > 0 ? results[1][0] : null;

  return {
    domains,
    app: state
      ? ({
          ...state,
          channels: _recordKeys(state.channels, 'domains') || {},
          expansions: _recordKeys(state.expansions, 'domains') || {},
          last_accessed:
            _recordKeys(state.last_accessed, 'domains', (x) =>
              _recordKeys(x, 'channels'),
            ) || {},
        } as RemoteAppState)
      : null,
  };
}

///////////////////////////////////////////////////////////
export async function makeSocketServer(server: HttpServer) {
  // Create socket.io server
  _socketServer = new SocketServer(server, {
    cors: {
      origin: config.domains.cors,
      methods: ['GET', 'POST'],
    },
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
        last_accessed: {},
        pings: {},
      },

      current_domain: app?.domain || '',
      current_channel: app?.channels?.[app?.domain || ''] || '',
      current_room: null,
    };

    // Disconnect previous socket
    const hasPrevSocket = _clients[profile_id]?.socket.connected;

    // Set new client
    _clients[profile_id] = client;

    // Dc prev socket
    if (hasPrevSocket) _clients[profile_id].socket.disconnect();

    // Create map of time each channel last had an event
    const currentChannels = client.current_domain
      ? await getDomainChannels(client.current_domain)
      : [];
    const lastEvent: Record<string, Date> = {};
    for (const channel of currentChannels)
      lastEvent[channel.id] = new Date(channel._last_event);

    // Join inactive type for all seen channels
    const inactive: string[] = [];
    for (const [channel_id, lastAccessed] of Object.entries(
      client.app?.last_accessed[client.current_domain] || {},
    )) {
      // Skip if the channel is the current
      if (channel_id === client.current_channel) continue;

      // Add to inactive room if the last time the user accessed the channel is greater than or equal to the time of the last event (meaning the channel is completely seen)
      if (
        lastEvent[channel_id] &&
        new Date(lastAccessed) >= lastEvent[channel_id]
      )
        inactive.push(_inactive(channel_id));
    }

    // Join inactive types for channels in the domain that are seen, and active for the current viewing channel
    socket.join(inactive);
    if (client.current_channel) socket.join(client.current_channel);

    // Join domain for domain specific updates (i.e. user join/leave)
    if (client.current_domain) socket.join(client.current_domain);

    // Mark profile as online
    query(sql.update<Profile>(profile_id, { set: { online: true } }));

    // Notify in every domain the user is in that they joined
    socket.to(Object.keys(domains)).emit('general:user-joined', profile_id);

    // Called when the socket disconnects for any reason
    socket.on(
      'disconnect',
      wrapper.event(
        (reason) => {
          // Check if socket is still connected (i.e. user tried connecting twice and the second connection booted the first one off)
          if (_clients[profile_id].socket.id !== socket.id) return;

          // These updates do not need to be a transaction
          const state_id = `app_states:${client.profile_id.split(':')[1]}`;
          const ops = [
            // Mark profile as offline
            sql.update<Profile>(profile_id, { set: { online: false } }),
            // Update last accessed on user leave
            sql.update<RemoteAppState>(state_id, {
              patch: [
                {
                  op: 'add',
                  path: `last_accessed/${id(client.current_domain)}/${id(
                    client.current_channel,
                  )}`,
                  value: sql.$('time::now()'),
                },
              ],
              return: 'NONE',
            }),
          ];

          // Code to disconnect user from rtc room if needed
          if (client.current_room) {
            // Remove participant from channel in db
            ops.push(
              sql.update<Channel>(client.current_room, {
                set: { 'data.participants': ['-=', client.profile_id] },
                return: 'NONE',
              }),
            );

            // Broadcast user leave event
            const profile_id = client.profile_id;
            getChannel(client.current_room).then((channel) => {
              // Emit
              _socketServer
                .to(channel.domain)
                .to(`${channel.id}.rtc`)
                .emit('rtc:user-left', channel.domain, channel.id, profile_id);
            });
          }

          // Execute updates
          query(sql.multi(ops));

          // Notify in every domain the user is in that they left
          socket.to(Object.keys(domains)).emit('general:user-left', profile_id);

          // Remove client from map
          delete _clients[profile_id];

          // Logging
          log.info(`client disconnected`, { sender: profile_id });
        },
        { client },
      ),
    );

    // Called when user switches the channel/domain they are viewing
    socket.on(
      'general:switch-room',
      wrapper.event(async (domain_id: string, channel_id: string) => {
        if (!domain_id || !channel_id)
          throw new Error('must provide a domain and a channel');

        // Make sure user has permission to view channel
        const state_id = `app_states:${client.profile_id.split(':')[1]}`;
        const canView = await query<boolean>(
          sql.transaction([
            sql.let(
              '$allowed',
              hasPermission(
                client.profile_id,
                channel_id,
                'can_view',
                domain_id,
              ),
            ),
            sql.if({
              cond: '$allowed = true',
              body: sql.update<RemoteAppState>(state_id, {
                patch: [
                  {
                    op: 'add',
                    path: 'domain',
                    value: domain_id,
                  },
                  {
                    op: 'add',
                    path: `channels/${id(domain_id)}`,
                    value: channel_id,
                  },
                  {
                    op: 'add',
                    path: `last_accessed/${id(domain_id)}/${id(channel_id)}`,
                    value: sql.$('time::now()'),
                  },
                  {
                    op: 'add',
                    path: `pings/${id(channel_id)}`,
                    value: 0,
                  },
                ],
                return: 'NONE',
              }),
            }),
            sql.return('$allowed'),
          ]),
        );

        if (!canView)
          throw new Error(
            'you do not have permission to view the requested channel',
          );

        // Update last accessed locally
        if (!client.app.last_accessed[client.current_domain])
          client.app.last_accessed[client.current_domain] = {};
        client.app.last_accessed[client.current_domain][
          client.current_channel
        ] = new Date().toISOString();

        // Leave old domain and join new
        if (domain_id !== client.current_domain) {
          // Create map of time each channel last had an event for new domain
          const currentChannels = await getDomainChannels(domain_id);
          const lastEvent: Record<string, Date> = {};
          for (const channel of currentChannels)
            lastEvent[channel.id] = new Date(channel._last_event);

          // Switch domain
          socket.leave(client.current_domain);
          socket.join(domain_id);

          // Switch active channel
          socket.leave(client.current_channel);
          socket.join(channel_id);

          // Leave all channels of old domain
          for (const channel_id of Object.keys(
            client.app.last_accessed[client.current_domain] || {},
          ))
            socket.leave(_inactive(channel_id));

          // Join all seen channels of new domain
          const newInactive: string[] = [];
          for (const [id, lastAccessed] of Object.entries(
            client.app.last_accessed[domain_id] || {},
          )) {
            // Skip if the channel is the current
            if (id === channel_id) continue;

            if (lastEvent[id] && new Date(lastAccessed) >= lastEvent[id])
              newInactive.push(_inactive(id));
          }
          socket.join(newInactive);

          // Update current
          client.current_channel = channel_id;
          client.current_domain = domain_id;
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

          // Update current
          client.current_channel = channel_id;
        }

        // setTimeout(() => console.log(socket.rooms), 1000);
      }),
    );

    // Called when a client wants to update their app state
    socket.on(
      'general:update-app-state',
      wrapper.event(async (state: DeepPartial<RemoteAppState>) => {
        // Validation/transform
        if (state.last_accessed) {
          state.last_accessed = transformObject(state.last_accessed, (k, v) => [
            id(k),
            transformObject(v, (k, v) => [id(k), isBool(v)]),
          ]);
        }

        if (state.pings)
          state.pings = transformObject(state.pings, (k, v) => [id(k), v]);

        if (state.right_panel_opened)
          state.right_panel_opened = isBool(state.right_panel_opened);

        if (state.chat_states) {
          state.chat_states = transformObject(state.chat_states, (k, v) => [
            id(k),
            v,
          ]);
        }

        if (state.board_states) {
          state.board_states = transformObject(state.board_states, (k, v) => [
            id(k),
            v,
          ]);
        }

        // Pick only needed states
        state = pick(state, [
          'last_accessed',
          'pings',
          'right_panel_opened',
          'chat_states',
          'board_states',
        ]);

        // Update state
        const state_id = `app_states:${client.profile_id.split(':')[1]}`;
        await query<any[]>(
          sql.update(state_id, {
            content: state,
            merge: true,
          }),
        );
      }),
    );

    // Add message handlers
    addChatHandlers(client);

    // Add rtc handlers
    addRtcHandlers(client);

    // Join logging
    log.info(`new connection`, { sender: profile_id });
  });
}

///////////////////////////////////////////////////////////
export function io() {
  return _socketServer;
}

///////////////////////////////////////////////////////////
export function clients() {
  return _clients;
}

/**
 * Get socket client for a user, but returns io as back up
 *
 * @param profile_id The id of the user
 * @returns The a socket
 */
export function getClientSocketOrIo(profile_id: string | undefined) {
  return profile_id
    ? _clients[profile_id]?.socket || _socketServer
    : _socketServer;
}

/** Channel emit options */
type ChannelEmitOptions = {
  /** The profile id of the user that is emitting the event (used to exclude the sender from recieving the event) */
  profile_id?: string;
  /** Should this count as an event (default true). If true, then the `_last_event` field will be updated */
  is_event?: boolean;
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
export async function emitChannelEvent(
  channel_id: string,
  emitter: (
    room: ReturnType<Socket['to']>,
    channel: Channel,
  ) => void | Promise<void>,
  options?: ChannelEmitOptions,
) {
  // Get socket to emit
  const socket = getClientSocketOrIo(options?.profile_id);

  // Get channel object to get domain
  const channel = await getChannel(channel_id);

  // Emit the activity event to inactive channel
  socket
    .to(_inactive(channel_id))
    .emit(
      'general:activity',
      channel.domain,
      channel_id,
      options?.is_event !== false,
    );
  // Emit the event to active channel
  await emitter(socket.to(channel_id), channel);

  // WIP : Update client side acitivty handler, update client code to use last_event and last_acceessed, test to make sure everything still works, force domain refresh on every mount (throttle by ~5 secs)

  // Code to update latest event tracker
  if (options?.is_event !== false) {
    /// Update latest event time
    query(
      sql.update<Channel>(channel_id, {
        set: { _last_event: sql.$('time::now()') },
      }),
    );

    // Update locally
    const cache = getDomainChannelsCache();
    const entry = cache._data[channel.domain]?.data?.find(
      (x) => x.id === channel_id,
    );
    if (entry) entry._last_event = new Date().toISOString();

    // Make all clients leave the inactive channel room
    _socketServer.socketsLeave(_inactive(channel_id));
  }
}
