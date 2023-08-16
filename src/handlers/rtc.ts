import { getChannel } from '../utility/db';
import { Client } from '../types';
import wrapper from '../utility/wrapper';
import { io } from '../sockets';
import assert from 'assert';


/** Rtc channel room key */
function _rtc(channel_id: string) { return `${channel_id}.rtc` }


/**
 * Add rtc event handlers to client
 * 
 * @param client The client to add handlers to
 */
export function addRtcHandlers(client: Client) {
	// User joined an rtc room
	client.socket.on('rtc:joined', wrapper.event(async (channel_id) => {
		// Do nothing of already in the specified room
		if (client.current_room === channel_id) return;

		// Leave prev room
		if (client.current_room)
			client.socket.leave(_rtc(client.current_room));

		// Add socket to new rtc room
		client.socket.join(_rtc(channel_id));

		// Update current room
		client.current_room = channel_id;

		// Broadcast to domain and rtc room
		const channel = await getChannel(channel_id);
		io().to(_rtc(channel_id)).to(channel.domain).emit('rtc:user-joined', channel.domain, channel_id, client.profile_id);
	}, { client }));

	// User left an rtc room
	client.socket.on('rtc:left', wrapper.event(async (channel_id) => {
		// Make sure channel id is the current room
		assert(client.current_room === channel_id);

		// Leave room
		client.socket.leave(_rtc(channel_id));

		// Update current room
		client.current_room = null;
		
		// Broadcast to domain and rtc room
		const channel = await getChannel(channel_id);
		io().to(_rtc(channel_id)).to(channel.domain).emit('rtc:user-left', channel.domain, channel_id, client.profile_id);
	}));
}