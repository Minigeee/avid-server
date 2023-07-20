import { getChannel } from '../utility/db';
import { Client } from '../types';
import wrapper from '../utility/wrapper';


/**
 * Add chat event handlers to client
 * 
 * @param client The client to add handlers to
 */
export function addChatHandlers(client: Client) {
	// Chat message
	client.socket.on('chat:message', wrapper.event(async (message) => {
		// Get channel data
		const channel = await getChannel(message.channel);

		// TODO : Broadcast this message to roles that have read permission for this channel, rather than the domain
		client.socket.to(channel.domain).emit('chat:message', channel.domain, message);
	}, { client, message: 'An error occurred while broadcasting message' }));

	// Chat user start/stop typing
	client.socket.on('chat:typing', wrapper.event(async (profile_id, channel_id, type) => {
		// Get channel data
		const channel = await getChannel(channel_id);

		// TODO : Broadcast this message to roles that have read permission for this channel, rather than the domain
		client.socket.to(channel.domain).emit('chat:typing', profile_id, channel_id, type);
	}, { client }));
}