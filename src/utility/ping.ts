import { Member, RemoteAppState } from '@app/types';
import { new_Record, query, sql } from './query';
import assert from 'assert';
import { clients } from '../sockets';


/** Ping options */
export type PingOptions = {
	/** List of members to ping */
	member_ids?: string[];
	/** List of roles to ping */
	role_ids?: string[];
	/** The id of the sender */
	sender_id?: string;
};


/**
 * Ping the given members and roles in the given channel
 * 
 * @param domain_id The id of the domain where the ping occurred
 * @param channel_id The id of the channel where the ping occurred
 * @param options Ping options
 */
export async function ping(domain_id: string, channel_id: string, options: PingOptions) {
	if (!options.member_ids?.length && !options.role_ids?.length) return;

	// Unique member ids
	const member_ids = options.member_ids ? Array.from(new Set(options.member_ids)) : [];

	// List of operations
	const ops = [
		// List of member ids to ping
		sql.let('$members', options.role_ids?.length ? member_ids.length > 0 ? `array::group($members_from_roles, ${member_ids.join(',')})` : '$members_from_roles' : `[${member_ids.join(',')}]`),
		// Convert profile ids to app states
		sql.let('$app_states', sql.fn(function (members: string[]) {
			return members.map(x => new_Record('app_states', x.toString().split(':')[1]));
		}).__esc__),
		// Increment ping counter
		sql.update<RemoteAppState>('$app_states', {
			// Update only users that are not viewing channel
			where: sql.match<RemoteAppState>({
				domain: ['!=', domain_id],
				[`channels.${domain_id.split(':')[1]}`]: ['!=', channel_id],
			}, '||'),
			set: {
				[`pings.${channel_id.split(':')[1]}`]: ['+=', 1],
			},
			return: ['id'],
		}),
	];

	// Add member fetch from member
	if (options.role_ids?.length) {
		ops.splice(0, 0, sql.let('$members_from_roles',
			sql.select<Member>(['in'], {
				from: `${domain_id}<-member_of`,
				where: sql.match<Member>({ roles: ['CONTAINSANY', options.role_ids] }),
				value: true,
			}),
		));
	}

	// Apply pings to database
	console.log(sql.transaction(ops))
	const results = await query<{ id: string }[]>(sql.transaction(ops));
	assert (results && results.length > 0);
	const profile_ids = results.map(state => `profiles:${state.id.split(':')[1]}`);

	// Send ping event
	const clientMap = clients();
	const offline: string[] = [];

	for (const profile_id of profile_ids) {
		// Skip sender
		if (profile_id === options.sender_id)
			continue;

		// Get client
		const client = clientMap[profile_id];
		if (!client) {
			offline.push(profile_id);
			continue;
		}

		// Emit
		console.log('emit to', client.profile_id)
		client.socket.emit('general:ping', domain_id, channel_id);
	}

	// TODO : Send noti to members that are not online
}