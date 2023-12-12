import v from 'validator';
import { record } from './query';

import _sanitizeHtml from 'sanitize-html';

/*
These validators are mostly for values that will not be going into the database, since
the database does validation of its own.
*/


export type IsNumberOpts = { min?: number; max?: number };
export type IsArrayOpts = { minlen?: number; maxlen?: number };


////////////////////////////////////////////////////////////
export function sanitizeHtml(value: string) {
	return _sanitizeHtml(value, {
		allowedTags: [
			..._sanitizeHtml.defaults.allowedTags,
			'img',
		],
		allowedAttributes: {
			..._sanitizeHtml.defaults.allowedAttributes,
			'*': ['style'],
		},
		allowedClasses: {
			code: ['language-*'],
			'*': ['avid*', 'hljs*'],
		},
	} as _sanitizeHtml.IOptions);
}


////////////////////////////////////////////////////////////
type SchemaField<T, K extends keyof T> = { required: undefined extends T[K] ? false : true, transform: (value: any) => T[K] };
export function isObject<T>(value: any, schema: { [K in keyof T]-?: SchemaField<T, K> }) {
	const entries: [string, SchemaField<T, any>][] = Object.entries(schema);

	// Check if it is object
	if (typeof value !== 'object')
		throw new Error(`must be an object with fields ${entries.filter(([k, v]) => v.required).map(([k, v]) => `\`${k}\``).join(', ')}`);

	const result: any = {};

	// Check all schema entries
	for (const [k, v] of entries) {
		// Check if the field is present
		if (v.required && value[k] === undefined)
			throw new Error(`\`${k}\` is a required field`);

		// Check if it is present
		else if (value[k] !== undefined) {
			// Do check
			try {
				result[k] = v.transform(value[k]);
			}
			catch (err: any) {
				throw new Error(`\`${k}\` ${err.message}`);
			}
		}
	}

	return result;
}


////////////////////////////////////////////////////////////
export function isArray<T>(value: any, transform: (value: any) => T, options?: IsArrayOpts) {
	if (!Array.isArray(value) || (options?.minlen !== undefined && value.length < options.minlen) || (options?.maxlen !== undefined && value.length > options.maxlen)) {
		const hasMin = options?.minlen !== undefined;
		const hasMax = options?.maxlen !== undefined;
		throw new Error(`must be an array ${hasMin || hasMax ? 'with a length ' : ''}${hasMin ? `>=${options.minlen}${hasMax ? ' and ' : ''}` : ''}${hasMax ? `<=${options.maxlen}` : ''}`);
	}

	const arr: T[] = value.map((x, i) => {
		try {
			return transform(x);
		}
		catch (err: any) {
			throw new Error(`[${i}] ${err.message}`);
		}
	});
	return arr;
}

////////////////////////////////////////////////////////////
export function asArray<T>(str: string, transform: (value: string) => T, options?: IsArrayOpts) {
	const strarr = str.split(',');
	return isArray(strarr, transform, options);
}


////////////////////////////////////////////////////////////
export function isIn<T>(value: any, values: T[]) {
	if (values.indexOf(value) < 0)
		throw new Error(`must be one of ${values.map(x => `"${x}"`).join(' | ')}`);
	return value;
}


////////////////////////////////////////////////////////////
export function isRecord(str: any, table: string) {
	if (typeof str !== 'string' || !str.startsWith(table + ':'))
		throw new Error(`must be an id in the form "${table}:[id]"`);
	return str;
}

////////////////////////////////////////////////////////////
export function asRecord(table: string, str: string) {
	if (!/^\w+$/.test(str))
		throw new Error(`must be a valid alphanumeric id that is not in the form "${table}:[id]"`);
	return record(table, str);
}


////////////////////////////////////////////////////////////
export function asBool(str: string) {
	str = str.toLowerCase();
	if (str !== 'true' && str !== 'false')
		throw new Error('must be either "true" or "false"');
	return str === 'true';
}

////////////////////////////////////////////////////////////
export function isBool(value: any) {
	if (typeof value !== 'boolean')
		throw new Error('must be a boolean');
	return value as boolean;
}


////////////////////////////////////////////////////////////
export function asInt(str: string, options?: IsNumberOpts) {
	const valid = v.isInt(str, options);
	if (!valid) {
		const hasMin = options?.min !== undefined;
		const hasMax = options?.max !== undefined;
		throw new Error(`must be an integer ${hasMin ? `>=${options.min}${hasMax ? ' and ' : ''}` : ''}${hasMax ? `<=${options.max}` : ''}`);
	}

	return parseInt(str);
}

////////////////////////////////////////////////////////////
export function isInt(value: any, options?: IsNumberOpts) {
	if (typeof value !== 'number' || (options?.min !== undefined && value < options.min) || (options?.max !== undefined && value > options.max)) {
		const hasMin = options?.min !== undefined;
		const hasMax = options?.max !== undefined;
		throw new Error(`must be an integer ${hasMin ? `>=${options.min}${hasMax ? ' and ' : ''}` : ''}${hasMax ? `<=${options.max}` : ''}`);
	}

	return value;
}


////////////////////////////////////////////////////////////
export function asDate(value: string) {
	if (!v.isISO8601(value))
		throw new Error('must be a valid ISO-8601 date string');
	return new Date(value);
}

////////////////////////////////////////////////////////////
export function isDate(value: any) {
	if (typeof value !== 'string' || !v.isISO8601(value))
		throw new Error('must be a valid ISO-8601 date string');
	return value;
}