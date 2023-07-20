import assert from 'assert';

import { Channel, Member } from '@app/types';

import config from '@/config';
import { query, sql } from './query';
import { AsyncCache } from './cache';

import { Surreal } from 'surrealdb.js';


/** Database connection */
export const db = new Surreal(`${config.db.url}/rpc`);


/** Caches */
const _caches = {
	/** Channel cache */
	channel: new AsyncCache<Channel>(async (keys) => {
		assert(keys.length === 1);

		const results = await query<Channel[]>(
			sql.select<Channel>('*', { from: keys[0] })
		);
		assert(results && results.length > 0);

		// Return domain
		return [results[0]];
	}),
};


/**
 * Get a map of domains the user belongs to, to a list of
 * roles assigned to the user within each domain.
 * 
 * @param profile_id The profile to retrieve domains for
 * @returns A map of domain ids to lists of role ids
 */
export async function getDomainsOfUser(profile_id: string) {
	// Get member info
	const results = await query<(Member & { out: string })[]>(
		sql.select<Member>(['out', 'roles'], { from: `${profile_id}->member_of` })
	);
	assert(results);

	// Create map
	const domains: Record<string, string[]> = {};
	for (const member of results)
		domains[member.out] = member.roles || [];

	return domains;
}


/**
 * Get a channel object
 * 
 * @param channel_id The id of the channel to retrieve
 * @returns The channel object
 */
export function getChannel(channel_id: string) {
	return _caches.channel.get(channel_id);
}