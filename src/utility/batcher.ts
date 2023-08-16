import { emitChannelEvent, io } from '../sockets';
import { ServerToClientEvents } from '@app/types';
import { getChannel } from './db';

/** All event batches */
const _batches: Record<string, any> = {};


/** All events signatures that should be batched */
export type BatchEvents = {
	'chat:reactions': (channel_id: string, message_id: string, emoji: string, delta: number) => void;
};

/** Batcher info */
type Batcher<E extends keyof BatchEvents> = {
	/** Time between broadcasting events (ms) */
	interval: number;
	/** Function used to initiate a batch */
	create: (batch: Partial<BatchData[E]>, ...args: Parameters<BatchEvents[E]>) => void;
	/** Function used to add event to batch */
	add: (batch: BatchData[E], ...args: Parameters<BatchEvents[E]>) => void;
	/** Function that broadcasts the batch event */
	emit: (batch: BatchData[E]) => void;
};


/** Batch data */
type BatchData = {
	'chat:reactions': {
		channel_id: string;
		message_id: string;
		changes: Record<string, number>;
	},
};


/** Batchers */
const _batchers: { [E in keyof BatchEvents]: Batcher<E> } = {
	'chat:reactions': {
		interval: 2000,
		create(batch, channel_id, message_id, emoji, delta) {
			batch.channel_id = channel_id;
			batch.message_id = message_id;
			batch.changes = {};
		},
		add(batch, channel_id, message_id, emoji, delta) {
			if (!batch.changes?.[emoji])
				batch.changes[emoji] = delta;
			else
				batch.changes[emoji] += delta;
		},
		emit({ channel_id, message_id, changes }) {
			// Emit as channel event
			emitChannelEvent(channel_id, (room) => {
				room.emit('chat:reactions', channel_id, message_id, changes, false);
			}, { is_event: false });
		},
	},
};


/**
 * Emit a batched event
 * 
 * @param event The event to emit
 * @param key The batch key (used to add events to a batch)
 * @param args 
 */
export function emitBatchEvent<E extends keyof BatchEvents>(event: E, key: string, ...args: Parameters<BatchEvents[E]>) {
	const batcher = _batchers[event];

	// Get batch
	const k = `${event}:${key}`;
	let entry = _batches[k];

	// Create batch if not exist
	if (!entry) {
		entry = _batches[k] = {};
		batcher.create(entry, ...args);

		// Create the emit timeout
		setTimeout(() => {
			try {
				batcher.emit(entry);
			}
			finally {
				delete _batches[k];
			}
		}, batcher.interval);
	}

	// Add event to batch
	batcher.add(entry, ...args);
}