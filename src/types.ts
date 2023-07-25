import { Socket as _Socket } from 'socket.io';
import { ClientToServerEvents, ServerToClientEvents } from '@app/types';

export type Socket = _Socket<ClientToServerEvents, ServerToClientEvents>;

/** A type representing a client user */
export type Client = {
    /** The id of the user */
    profile_id: string;
    /** The socket associated with the user */
    socket: Socket;
    /** A map of domain ids the user belongs to, to the roles assigned to the user within each domain */
    domains: Record<string, string[]>;

    /** The current domain the user is viewing */
    current_domain: string;
    /** The channel the user is currently viewing */
    current_channel: string;
};

/** A type representing a log entry */
export interface LogEntry {
    /** The id of the log entry (uuid) */
    id?: string | null;
    /** The time this log was generated */
    timestamp: Date;
    /** The location where the log entry originated from */
    location?: 'server' | 'client' | 'rtc' | null;
    /** The level of importance of the entry (0 is error...) */
    level: number;
    /** The message of the log entry */
    message: string;
    /** The route path this log was generated from */
    path?: string | null;
    /** The HTTP method this log was generated from */
    method?: string | null;
    /** The id of the sender where this log was generated */
    sender?: string | null;
    /** Any extra data */
    data?: any;
    /** The callstack of an error object (if available) */
    stack?: string | null;
};