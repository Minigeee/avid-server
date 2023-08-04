import { getChannel } from '../utility/db';
import { Client } from '../types';
import wrapper from '../utility/wrapper';


/**
 * Add chat event handlers to client
 * 
 * @param client The client to add handlers to
 */
export function addChatHandlers(client: Client) {
	// Chat user start/stop typing
	client.socket.on('chat:typing', wrapper.event(async (profile_id, channel_id, type) => {
		// Broadcast to active channel
		client.socket.to(channel_id).emit('chat:typing', profile_id, channel_id, type);
	}, { client }));
}