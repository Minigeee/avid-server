import assert from 'assert';

import { Channel, Member } from '@app/types';

import config from '../config';
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
	
	/** Domain channels (used for checking stale status for each user) */
	domain_channels: new AsyncCache<{ id: string; _last_event: string }[]>(async (keys) => {
		assert(keys.length === 1);

		const results = await query<Channel[]>(
			sql.select<Channel>(['id', '_last_event'], {
				from: 'channels',
				where: sql.match<Channel>({ domain: keys[0] }),
			})
		);
		assert(results && results.length > 0);

		// Return domain
		return [results];
	}),
};


/**
 * Get a channel object
 * 
 * @param channel_id The id of the channel to retrieve
 * @returns The channel object
 */
export function getChannel(channel_id: string) {
	return _caches.channel.get(channel_id);
}

/**
 * Get all channels in the given domain. Only the `id` and `_last_activity` properties
 * are returned, so this should only be used for checking stale status of channels.
 * 
 * @param domaoin_id The domain for which channels to get
 * @returns A list of channel objects
 */
export function getDomainChannels(domain_id: string) {
	return _caches.domain_channels.get(domain_id);
}

/**
 * Get domain channels cache
 */
export function getDomainChannelsCache() {
	return _caches.domain_channels;
}