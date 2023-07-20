import config from '@/config';
import { Request, Response, NextFunction } from 'express';



////////////////////////////////////////////////////////////
export class StatusError extends Error {
	status: number;
	data: any;

	constructor(msg: string, options?: { status?: number; data?: any }) {
		super(msg);
		this.status = options?.status || 500;
		this.data = options?.data;
	}
}

////////////////////////////////////////////////////////////
export const check = {
	error: (cond: any, msg: string) => {
		if (!cond) {
			throw new StatusError(msg, { status: 500 });
		}
	},
	warn: (cond: any, msg: string, status: number = 404) => {
		if (!cond) {
			throw new StatusError(msg, { status });
		}
	},
};


/** Error handler middleware */
export function errorHandler(err: any, req: Request, res: Response, next: NextFunction) {
	if (!err.status || err.status >= 500) {
		// Log error and report server error if the status indicates it
		if (req.log)
			req.log.error(err);

		if (config.dev_mode) {
			res.status(500).send(err.stack);
		}
		else {
			res.status(500).json({
				code: 500,
				error: 'An internal error occured',
			});
		}
	}

	else {
		if (req.log)
			req.log.warn(err);

		// Return warning
		res.status(err.status).json({
			status: err.status,
			error: err.message || 'An error occurred',
			...err.data,
		});
	}
}