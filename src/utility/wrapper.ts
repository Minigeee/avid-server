import { Request, Response, NextFunction, RequestHandler } from 'express';
import { log } from '../logs';
import { Client } from '../types';

type AsyncRequestHandler = (req: Request, res: Response, next: NextFunction) => Promise<any>;


const wrapper = {
	api: (fn: AsyncRequestHandler): RequestHandler => {
		return (req: Request, res: Response, next: NextFunction): void => {
			fn(req, res, next).then(() => next()).catch(next);
		};
	},
	event: <T extends (...args: any) => any>(handler: T, options?: { client?: Client; message?: string }): ((...args: Parameters<T>) => void) => {
		const handleError = (err: any) => {
			log.error(err, { sender: options?.client?.profile_id });

			// If a message exists, send this error event to user
			if (options?.client && options.message)
				options.client.socket.emit('error', options.message, 500);
		};
	
		return (...args: any) => {
			try {
				const ret = handler.apply(this, args);
				if (ret && typeof ret.catch === "function") {
					// async handler
					ret.catch(handleError);
				}
			} catch (e) {
				// sync handler
				handleError(e);
			}
		};
	},
};
export default wrapper;