import axios from 'axios';
import assert from 'assert';

import config from './config';


/** Db query options */
export type QueryOptions = {
	/** If full results should be returned. By default only the results of the last statement are returned. */
	complete?: boolean;
};

/**
 * Make a query to SurrealDB
 * 
 * @param sql The query string
 * @param options Query options
 * @returns A promise for the query results
 */
export async function query<T>(sql: string, options?: QueryOptions): Promise<T | null> {
	assert(process.env.SURREAL_USERNAME);
	assert(process.env.SURREAL_PASSWORD);

	// DB query
	const results = await axios.post(config.db.url, sql.trim(), {
		// Use username password auth if on server
		auth: {
			username: process.env.SURREAL_USERNAME,
			password: process.env.SURREAL_PASSWORD,
		},

		headers: {
			Accept: 'application/json',
			NS: config.db.namespace,
			DB: config.db.database,
		},
	});

	// Return if all results are ok
	for (const result of results.data) {
		if (result.status === 'ERR')
			// Error occurred
			throw new Error(result.detail[0]);
	}
	
	// Return results
	return options?.complete ? results.data.map((x: any) => x.result) : results.data.at(-1).result;
}


////////////////////////////////////////////////////////////
type _NestedPaths<T> = T extends string | number | boolean | Date | RegExp | Buffer | Uint8Array | ((...args: any[]) => any) | {
	_bsontype: string;
} ? never :
	T extends ReadonlyArray<infer A> ? ([] | _NestedPaths<A>) :
	T extends Map<string, any> ? [string] :
	T extends object ? {
		[K in keyof Required<T>]:
		T[K] extends T ? [K] : T extends T[K] ? [K] :
		[K, ...([] | _NestedPaths<T[K]>)];
	}[keyof T] : never;

type Join<T extends unknown[], D extends string> =
	T extends [] ? '' : T extends [string | number] ? `${T[0]}` : T extends [string | number, ...infer R] ? `${T[0]}${D}${Join<R, D>}` : string;

/** All selectable fields up to a certain recursion level */
export type Selectables<T> = Join<_NestedPaths<T>, '.'>;


/** Sql var accessor */
type SqlVarExpr = { __esc__: string };
/** Valid sql types */
type SqlType = number | string | SqlVarExpr;

/** Operators */
export type SqlOp = '&&' | '||' | '??' | '?:' | '=' | '!=' | '==' | '?=' | '*=' | '~'
	| '!~' | '*~' | '<' | '<=' | '>' | '>=' | '+' | '-' | '*' | '/'
	| '**' | 'IN' | 'NOT IN' | 'CONTAINS' | 'CONTAINSNOT' | 'CONTAINSALL' | 'CONTAINSANY' | 'CONTAINSNONE'
	| 'INSIDE' | 'NOTINSIDE' | 'ALLINSIDE' | 'ANYINSIDE' | 'NONEINSIDE' | 'OUTSIDE' | 'INTERSECTS';

/** Return modes */
export type SqlReturn = 'NONE' | 'BEFORE' | 'AFTER' | 'DIFF';

/** Content objects */
export type SqlContent<T> = (T extends object ? { [K in keyof T]?: SqlContent<T[K]> } :
	T extends ReadonlyArray<infer A> ? (A | SqlVarExpr)[] : T) | SqlVarExpr;

/** Relate statement options */
export type SqlRelateOptions<T extends object> = {
	/** Extra content that should be stored in relate edge */
	content?: SqlContent<T>;
	/** Return mode (by default NONE) */
	return?: SqlReturn | Selectables<T>[];
};

/** Update statement options */
export type SqlDeleteOptions<T extends object> = {
	/** Update condition */
	where?: string;
	/** Return mode (by default NONE) */
	return?: SqlReturn | Selectables<T>[];
};

/** Select statement options */
export type SqlSelectOptions<T extends object> = {
	/** Record to select from */
	from: string;
	/** Select condition */
	where?: string;
	/** Limit number of returned entries */
	limit?: number;
	/** The offset of entries to select */
	start?: number;
	/** Sort option */
	sort?: Selectables<T> | {
		/** The field to sort on */
		field: Selectables<T>;
		/** Sort order */
		order?: 'ASC' | 'DESC';
	}[];
	/** Fetch option */
	fetch?: (Selectables<T> | (string & {}))[];
};

type _SqlUpdateBaseOptions<T extends object> = {
	/** Update condition */
	where?: string;
	/** Return mode */
	return?: SqlReturn | Selectables<T>[];
};

type _SqlUpdateContentOptions<T extends object> = {
	/** Content of the update */
	content: SqlContent<T>;
	/** Whether update should merge or replace data (merge by default) */
	merge?: boolean;
} & _SqlUpdateBaseOptions<T>;

type _SqlUpdateSetOptions<T extends object> = {
	/** Data that should be incremented or decremented (or array push or pull) */
	set: { [K in keyof T]?: T[K] extends ReadonlyArray<infer A> ?
		(SqlContent<A> | SqlContent<A>[] | ['=' | '+=' | '-=', SqlContent<A> | SqlContent<A>[]]) :
		(SqlContent<T[K]> | ['=' | '+=' | '-=', SqlContent<T[K]>]) };
} & _SqlUpdateBaseOptions<T>;

/** Update statement options */
export type SqlUpdateOptions<T extends object> = _SqlUpdateContentOptions<T> | _SqlUpdateSetOptions<T>;


function _json(x: any, doubleBackslash: boolean = false): string {
    const type = typeof x;

    if (type === 'string')
        return `"${x.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
    else if (Array.isArray(x))
        return `[${x.map(x => _json(x, doubleBackslash)).join(',')}]`;
    else if (type === 'object') {
        if (x === null)
            return 'null';
        else if (x.__esc__ !== undefined)
            return x.__esc__;
        else if (x instanceof Date)
            return `"${x.toISOString()}"`;
        else {
            const rows: string[] = [];
            for (const [k, v] of Object.entries(x)) {
                if (v !== undefined)
                    rows.push(`${k}:${_json(v, doubleBackslash)}`);
            }
            return `{${rows.join(',')}}`;
        }
    }
    else
        return x;
}

function _fnstr(fn: any) {
    const str = fn.toString();
    const paramstr: string = str.match(/function[^\()]*\(([\s\S]*?)\)/)[1];
    const bodystr: string = str.match(/function[^{]+\{([\s\S]*)\}$/)[1];
	const lines = bodystr.split(/\r?\n/g).map(x => x.trim());

    return {
        params: paramstr ? paramstr.split(', ') : [],
        body: lines.filter(x => !x.startsWith('//')).join(' '),
    };
}

function _replace(str: string, v: string, replace: string) {
    return str.replace(new RegExp(`(\\b(?<!\\w\\.))(${v})(\\b)`, 'g'), replace);
}

/** SQL commands in function form for ease of use and future proofing */
export const sql = {
	/** Used to escape a string from being surrounded by quotations */
	$: (expr: string) => ({ __esc__: expr }),

	/** Create string from function */
	fn: <This extends object>(fn: (this: This, ...args: any[]) => any, hardcode?: Record<string, any>) => {
		let { params, body } = _fnstr(fn);
	
		// Replace parameters
		for (let i = 0; i < params.length; ++i)
			body = _replace(body, params[i], `arguments[${i}]`);
	
		// Replace hardcodes
		for (const [k, v] of Object.entries(hardcode || {}))
			body = _replace(body, k, _json(v, false));
	
		return { __esc__: `function(${params.map(x => `$${x}`).join(', ')}) {${body}}` };
	},

	/** Join a list of expressions with "and" */
	and: (exprs: string[]) => exprs.map(x => `(${x.trim()})`).join('&&') + ' ',

	/** Match a set of expressions and join them with "and" or "or", where each object key and value are being compared for equality.
	 * Other boolean operators can be used if object values are arrays, where [0] is the operator and [1] is the second operand */
	match: <T extends object>(conds: { [K in keyof T]?: SqlType | SqlContent<T[K]> | [SqlOp, SqlType] }, join: '&&' | '||' = '&&') =>
		Object.entries(conds).map(([k, v]) => !Array.isArray(v) ? `${k}=${_json(v)}` : `${k}${v[0]}${_json(v[1])}`).join(join) + ' ',

	/** Chain multiple statements */
	multi: (statements: string[]) => statements.map(x => x.trim()).join('; ') + ' ',
	
	/** Join a list of expressions with "or" */
	or: (exprs: string[]) => exprs.map(x => `(${x.trim()})`).join('||') + ' ',

	/** Wrap statement in parantheses */
	wrap: (expr: string, options?: { alias?: string, append?: string }) =>
		`(${expr.trim()})${options?.alias ? ` AS ${options.alias}` : options?.append} `,


	/** Create statement */
	create: <T extends object>(record: string, content: SqlContent<T>, ret?: SqlReturn | Selectables<T>[]) => {
		// Content string
		let json = _json(content);

		let q = `CREATE ${record} CONTENT ${json} `;
		if (ret)
			q += `RETURN ${typeof ret === 'string' ? ret : ret.join(',')} `;

		return q;
	},

	/** Delete statement */
	delete: <T extends object>(record: string | string[], options?: SqlDeleteOptions<T>) => {
		let q = `DELETE ${typeof record === 'string' ? record : record.join(',')} `;

		if (options?.where)
			q += `WHERE ${options.where} `;
			
		// Return
		const ret = options?.return;
		if (ret)
			q += `RETURN ${typeof ret === 'string' ? ret : ret.join(',')} `;

		return q;
	},

	/** Insert statement */
	insert: <T extends object>(table: string, values: SqlContent<T>[]) => {
		// Get keys
		const keySet = new Set<string>();
		for (const obj of values) {
			for (const k of Object.keys(obj))
				keySet.add(k);
		}
		const keys = Array.from(keySet);

		// Construct value strings
		const strs: string[] = [];
		for (const obj of values)
			strs.push(`(${keys.map(k => _json(obj[k as keyof SqlContent<T>])).join(',')})`);

		// Put parts togther
		return `INSERT INTO ${table} (${keys.join(',')}) VALUES ${strs.join(',')} `;
	},

	/** Relate statement */
	relate: <T extends object>(from: string, edge: string, to: string, options?: SqlRelateOptions<T>) => {
		let q = `RELATE ${from.includes('.') ? `(${from})` : from}->${edge}->${to.includes('.') ? `(${to})` : to} `;
		
		// Content string
		if (options?.content) {
			let json = _json(options.content);
			q += `CONTENT ${json} `;
		}

		// Return
		const ret = options?.return || 'NONE';
		q += `RETURN ${typeof ret === 'string' ? ret : ret.join(',')} `;

		return q;
	},

	/** Select statement */
	select: <T extends object>(fields: '*' | (Selectables<T> | (string & {}))[], options: SqlSelectOptions<T>) => {
		let q = `SELECT ${typeof fields === 'string' ? '*' : fields.join(',')} FROM ${options.from} `;
		if (options.where)
			q += `WHERE ${options.where} `;

		if (options.sort) {
			if (Array.isArray(options.sort))
				q += `ORDER BY ${options.sort.map(x => `${x.field} ${x.order || 'ASC'}`).join(',')} `;
			else
				q += `ORDER BY ${options.sort} `;
		}
		
		if (options.limit)
			q += `LIMIT ${options.limit} `;
		if (options.start)
			q += `START ${options.start} `;
		if (options.fetch)
			q += `FETCH ${options.fetch.join(',')} `;

		return q;
	},

	/** Update statement */
	update: <T extends object>(record: string, options: SqlUpdateOptions<T>) => {
		let q = `UPDATE ${record} `;

		// Check if SET should be used
		if ((options as _SqlUpdateSetOptions<T>).set) {
			// All must be set using merge
			const set = Object.entries((options as _SqlUpdateSetOptions<T>).set).map(([k, v]) =>
				Array.isArray(v) && (v[0] === '=' || v[0] === '+=' || v[0] === '-=') ?
					`${k}${v[0]}${_json(v[1])}` :
					`${k}=${_json(v)}`
			).join(',');

			q += `SET ${set} `;
		}
		else {
			// CONTENT or MERGE should be used
			const opts = options as _SqlUpdateContentOptions<T>;
			let json = _json(opts.content);
			q += `${opts.merge === false ? 'CONTENT' : 'MERGE'} ${json} `;
		}
		
		if (options?.where)
			q += `WHERE ${options.where} `;
		if (options?.return)
			q += `RETURN ${typeof options.return === 'string' ? options.return : options.return.join(',')} `;

		return q;
	},
	
	
	/** Let statement */
	let: (name: `$${string}`, expr: string) => `LET ${name} = ${expr} `,

	/** If statement */
	if: (...blocks: { cond?: string; body: string; }[]) => {
		let q = `IF ${blocks[0].cond} THEN ${blocks[0].body.trim()} `;
		for (let i = 1; i < blocks.length; ++i) {
			const { cond, body } = blocks[i];
			q += `${cond ? `ELSE IF ${cond} THEN ` : 'ELSE '}${body.trim()} `;
		}
		q += 'END ';

		return q;
	},

	/** Transaction statement (automatically wraps multiple statements) */
	transaction: (statements: string[]) =>
		`BEGIN TRANSACTION; ${statements.map(x => x.trim()).join('; ')}; COMMIT TRANSACTION `,
};