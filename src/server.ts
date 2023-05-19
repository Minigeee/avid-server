// Load environment variables
import dotenv from 'dotenv';
dotenv.config();

import { createServer as createHttpServer, IncomingMessage, Server as HttpServer } from 'http';

import express, { Express, Request, Response, NextFunction } from 'express';
import { Server as SocketServer, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';

import config from './config';
import { getDomainsOfUser } from './db';
import { getJwtPublic } from './utility/keys';
import wrapper from './utility/wrapper';
import { log } from './logs';
import { Client } from './types';

import { Media_ClientToServerEvents, Media_ServerToClientEvents } from '@app/types';

import { addChatHandlers } from './handlers/chat';


let _httpServer: HttpServer;
let _expressApp: Express;
let _socketServer: SocketServer<Media_ClientToServerEvents, Media_ServerToClientEvents>;

/** A map of profile ids to client objects */
const _clients: Record<string, Client> = {};


///////////////////////////////////////////////////////////
async function makeExpressServer() {
    _expressApp = express();
    _httpServer = createHttpServer(_expressApp);

    // Launch express app
    const port = process.env.PORT || 3001;
    _httpServer.listen(port, () => console.log(`Realtime server running on port ${port}`));
}


///////////////////////////////////////////////////////////
function getSessionUser(token?: string) {
    if (!token) return;

    try {
        const payload = jwt.verify(token, getJwtPublic());
        return payload as { profile_id: string; };
    }
    catch (error) {
        return;
    }
}


///////////////////////////////////////////////////////////
async function makeSocketServer() {
	// Create socket.io server
	_socketServer = new SocketServer(_httpServer, {
		cors: {
			origin: config.domains.site,
			methods: ['GET', 'POST'],
		}
	});

	// Handle client connect
	_socketServer.on('connection', async (socket) => {
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
		const domains = await getDomainsOfUser(profile_id);

		// Create client object
		const client: Client = {
			profile_id,
			socket,
			domains,

			current_domain: '',
		};
		_clients[profile_id] = client;

		// TODO : Performance optimization - only send messages to domain if the user is viewing it or there are no other unseen events in that domain
		// Add client to all domain rooms
		socket.join(Object.keys(domains));


		// Called when the socket disconnects for any reason
		socket.on('disconnect', wrapper.event((reason) => {
			// Remove client from map
			delete _clients[profile_id];

			// Logging
			log.info(`client disconnected`, { sender: profile_id });
		}, { client }));

		// Add message handlers
		addChatHandlers(client);
		

		// Join logging
		log.info(`new connection`, { sender: profile_id });
	});
}

///////////////////////////////////////////////////////////
export function io() { return _socketServer; }


///////////////////////////////////////////////////////////
async function main() {
    // Create express (and http) server
    await makeExpressServer();

    // Create socket.io server
    await makeSocketServer();
}


main();