import { appendFile } from 'fs';

import printf from 'printf';
import axios from 'axios';
import { v4 as uuid } from 'uuid';

import { Request, Response, NextFunction } from 'express';

import config from './config';

import { LogEntry } from './types';


////////////////////////////////////////////////////////////
const LOG_LOCAL = config.logger.mode === 'full' || config.logger.mode === 'local';
const LOG_REMOTE = config.logger.mode === 'full' || config.logger.mode === 'remote';


////////////////////////////////////////////////////////////
const LEVEL_NAMES = [
    'error',
    'warn',
    'info',
    'verbose',
    'debug',
];

////////////////////////////////////////////////////////////
const CONSOLE_COLORS: Record<string, string> = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    dim: '\x1b[2m',
    underscore: '\x1b[4m',
    blink: '\x1b[5m',
    reverse: '\x1b[7m',

    black: '\x1b[30m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    white: '\x1b[37m',

    bred: '\x1b[1;31m',
    bblue: '\x1b[1;34m',
    bgreen: '\x1b[1;32m',
    byellow: '\x1b[1;33m',
    bmagenta: '\x1b[1;35m',
    bcyan: '\x1b[1;36m',
};

////////////////////////////////////////////////////////////
const LEVEL_COLORS: string[] = [
    'red',
    'yellow',
    'green',
    'cyan',
    'bmagenta',
];

////////////////////////////////////////////////////////////
const METHOD_COLORS: Record<string, string> = {
    GET: 'bblue',
    POST: 'bgreen',
    PUT: 'byellow',
    PATCH: 'bcyan',
    DELETE: 'bred',
};


////////////////////////////////////////////////////////////
declare global {
    namespace Express {
        interface Request {
            log: Logger;
        }
    }
}


////////////////////////////////////////////////////////////
export interface LogOptions {
    level?: number;
    data?: any;
    stack?: string | null;
    sender?: string | null;

    /** Indicates if log should be printed to console (only local) */
    console?: boolean;
}


////////////////////////////////////////////////////////////
function denullify(x: any) {
    const y = { ...x };
    for (const [k, v] of Object.entries(x)) {
        if (v === null)
            delete y[k];
    }
    return y;
}


////////////////////////////////////////////////////////////
export class Logger {
    private req?: Request;

    path?: string | null;
    method: string | null;
    sender: string | null;


    ////////////////////////////////////////////////////////////
    constructor({ req }: { req?: Request }) {
        if (req) {
            this.req = req;
            this.path = req.originalUrl ? req.originalUrl.split('?').shift() : 'websocket';
            this.method = req.method || null;
        }
        else {
            this.path = null;
            this.method = null;
        }

        this.sender = null;
    }


    ////////////////////////////////////////////////////////////
    _logRemote(log: LogEntry) {
        // Insert log into database
        /* TODO : Logs().insertOne(log).then(results => {
            // Send discord update for errors
            if (config.logger.discord_webhook && log.level === 0) {
                // Format date
                const formattedTime = new Intl.DateTimeFormat(undefined, {
                    dateStyle: 'long',
                    timeStyle: 'long',
                    timeZone: 'America/Chicago'
                }).format(log.timestamp);

                // Send discord message
                return axios.post(config.logger.discord_webhook, {
                    content: config.logger.discord_role_id ? `<@&${config.logger.discord_role_id}>\n` : undefined,
                    embeds: [{
                        title: `RTC Error (${log.id})`,
                        color: 0xFA5252,
                        timestamp: log.timestamp,
                        description:
                            `**Time**\n${formattedTime}\n\n` +
                            (this.method && this.path ?
                                `**Request**\n${this.method} ${this.path}\n\n` :
                                '') +
                            (this.sender ?
                                `**Sender**\n${this.sender}\n\n` :
                                '') +
                            `**Message**\n${log.message}\n\n` +
                            `**Call Stack**\n\`\`\`${log.stack}\`\`\``
                    }],
                });
            }
        }); */
    }

    ////////////////////////////////////////////////////////////
    log(message: string, options: LogOptions = {}): void {
        // Defaults
        options.level = options.level === undefined ? 3 : options.level;
        options.data = options.data || null;
        options.stack = options.stack || null;

        // Skip if debug log and in dev mode
        const debug = options.level === 4;
        const devmode = config.dev_mode;
        if (debug && !devmode) return;

        // Log time stamp
        const timestamp = new Date();

        // Log local
        if (LOG_LOCAL && (options.console || options.console === undefined)) {
            const offsetMs = timestamp.getTimezoneOffset() * 60 * 1000;
            const dateLocal = new Date(timestamp.getTime() - offsetMs);
            const timeStr = dateLocal.toISOString().replace('T', ' ').replace('Z', '');

            // Get text colors
            const colors = {
                reset: CONSOLE_COLORS.reset,
                time: CONSOLE_COLORS.bright + CONSOLE_COLORS.white,
                method: this.method ? CONSOLE_COLORS[METHOD_COLORS[this.method]] : CONSOLE_COLORS.reset,
                level: CONSOLE_COLORS[LEVEL_COLORS[options.level]],
            };

            console.log(printf(`${colors.time}[%s]${colors.reset} | ${colors.method}%-6s${colors.reset} | %-35s | ${colors.level}%-12s %s`,
                timeStr,
                this.method ? this.method.toUpperCase() : null,
                this.path,
                LEVEL_NAMES[options.level] + colors.reset + ':',
                message
            ));

            // Print stack if provided
            if (options.stack)
                console.log(colors.level + options.stack + colors.level);
        }

        // Create log object
        const log: LogEntry = {
            id: options.level <= config.logger.id_level ? uuid() : null,
            timestamp: timestamp,
            location: 'rtc',
            level: options.level,
            path: this.path,
            method: this.method ? this.method.toLowerCase() : null,
            sender: this.sender,
            data: options.data,
            message,
            stack: options.level === 0 ? options.stack : null,
        };

        // Log file
        if (config.logger.log_file && !debug) {
            const fname = config.dev_mode ? 'server.log' : `logs/${new Date().toISOString().slice(0, 10)}.${process.pid}.log`;
            appendFile(fname, JSON.stringify(denullify({ ...log, location: null })) + ',\n', (err) => {
                if (err) {
                    this._logRemote({
                        ...log,
                        id: uuid(),
                        level: 0,
                        message: err.message,
                        stack: err.stack,
                    });
                }
            });
        }

        // Log remote, only log messages at or above log level specified
        if (options.level <= config.logger.remote_level && LOG_REMOTE)
            this._logRemote(log);
    }


    ////////////////////////////////////////////////////////////
    error(message: string | Error, options?: LogOptions): void {
        // For error, include as much detail as possible
        if (this.req) {
            options = {
                ...options,

                data: {
                    ...(options?.data || {}),
                    params: this.req.params,
                    query: this.req.query,
                    body: this.req.headers['content-type'] === 'application/json' ? this.req.body : null,
                },
            };
        }

        // Add stack if message is an error object
        if (message instanceof Error) {
            this.log(message.message, {
                ...options,
                level: 0,
                stack: message.stack,
            });
        }

        else {
            this.log(message, { ...options, level: 0 });
        }
    }

    ////////////////////////////////////////////////////////////
    warn(message: string | Error, options?: LogOptions): void {
        // Add stack if message is an error object
        if (message instanceof Error) {
            this.log(message.message, {
                ...options,
                level: 1,
                stack: message.stack,
            });
        }

        else {
            this.log(message, { ...options, level: 1 });
        }
    }

    ////////////////////////////////////////////////////////////
    info(message: string, options?: LogOptions): void {
        this.log(message, { ...options, level: 2 });
    }

    ////////////////////////////////////////////////////////////
    verbose(message: string, options?: LogOptions): void {
        this.log(message, { ...options, level: 3 });
    }

    ////////////////////////////////////////////////////////////
    debug(message: string, options?: LogOptions): void {
        this.log(message, { ...options, level: 4 });
    }
}


// Default logger
const logger = new Logger({});
export { logger as log };


////////////////////////////////////////////////////////////
export function addLogger(req: Request, res: Response, next: NextFunction): void {
    // Add logger
    req.log = new Logger({ req });

    // Log to indicate that this route was requested
    req.log.verbose('start');

    next();
}

////////////////////////////////////////////////////////////
export function addEndLogger(req: Request, res: Response, next: NextFunction): void {
    // Log to indicate that this route went through to end
    req.log.verbose('end', { console: false });
}