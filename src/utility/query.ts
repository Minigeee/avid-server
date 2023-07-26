import assert from 'assert';

import config from '../config';
import { AllPermissions } from '@app/types';
import { Logger, log } from '../logs';
import { db } from './db';


/** Db query options */
export type QueryOptions = {
	/** Logger for debug logging */
	log?: Logger
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
	const results = await db.query(sql);
	(options?.log || log).debug(JSON.stringify({
		query: sql.length > 50 ? sql.slice(0, 47) + '...' : sql,
		results: results.map(x => ({ ...x, result: '...' })),
	}));

	// Return if all results are ok
	for (const result of results) {
		if (result.status === 'ERR')
			// Error occurred
			throw new Error(result.detail);
	}
	
	// Return results
	return options?.complete ? results.map((x: any) => x.result) as T : results.at(-1)?.result as T || null;
}


/**
 * Get the id of a SQL record.
 * 
 * @param record The record to get id from
 * @returns A string containing the id part of the original record
 */
export function id(record: string) {
	return record.split(':').at(-1) as string;
}

/**
 * Create a record out of the given id
 * 
 * @param record The record to get id from
 * @returns A string containing the id part of the original record
 */
export function record(table: string, id: string) {
	return `${table}:${id}`;
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
		/** Sort mode */
		mode?: 'COLLATE' | 'NUMERIC';
	}[];
	/** Fetch option */
	fetch?: (Selectables<T> | (string & {}))[];
	/** Group by */
	group?: 'all' | (Selectables<T> | (string & {}))[];
};

type _SqlUpdateBaseOptions<T extends object> = {
	/** Update condition */
	where?: string;
	/** Return mode, AFTER by default */
	return?: SqlReturn | (Selectables<T> | (string & {}))[];
};

type _SqlUpdateContentOptions<T extends object> = {
	/** Content of the update */
	content: SqlContent<T>;
	/** Whether update should merge or replace data (merge by default) */
	merge?: boolean;
} & _SqlUpdateBaseOptions<T>;

type _SqlUpdateSetOptions<T extends object> = {
	/** Data that should be incremented or decremented (or array push or pull) */
	set: { [K in Selectables<T>]?: K extends keyof T ? T[K] extends ReadonlyArray<infer A> ?
		(SqlContent<A> | SqlContent<A>[] | ['=' | '+=' | '-=', SqlContent<A> | SqlContent<A>[]]) :
		(SqlContent<T[K]> | ['=' | '+=' | '-=', SqlContent<T[K]>]) : any };
} & _SqlUpdateBaseOptions<T>;

/** Update statement options */
export type SqlUpdateOptions<T extends object> = _SqlUpdateContentOptions<T> | _SqlUpdateSetOptions<T>;

/** Insert statement options */
type SqlInsertOptions<T extends object> = {
	/** Values to set on insert key conflict */
	on_conflict?: _SqlUpdateSetOptions<T>['set'],
};


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

		// Builtin objects
		body = body.replace(/\(\d.+?new_Record\)/g, 'new Record');

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
		Object.entries(conds).map(([k, v]) => !Array.isArray(v) ? `${k}=${_json(v)}` : `${k} ${v[0]} ${_json(v[1])}`).join(join) + ' ',

	/** Chain multiple statements */
	multi: (statements: string[]) => statements.map(x => x.trim()).join('; ') + ' ',
	
	/** Join a list of expressions with "or" */
	or: (exprs: string[]) => exprs.map(x => `(${x.trim()})`).join('||') + ' ',

	/** Return statement */
	return: (expr: string) => `RETURN ${expr} `,

	/** Wrap statement in parantheses */
	wrap: (expr: string, options?: { alias?: string, append?: string }) =>
		`(${expr.trim()})${options?.alias ? ` AS ${options.alias}` : (options?.append || '')} `,


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
	insert: <T extends object>(table: string, values: SqlContent<T>[], options?: SqlInsertOptions<T>) => {
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

		// Construct on conflict string
		let onConflict = '';
		if (options?.on_conflict) {
			const exprs: string[] = [];
			for (const [k, v] of Object.entries((options as SqlInsertOptions<T>).on_conflict || {})) {
				if (v === undefined) continue;

				exprs.push(Array.isArray(v) && (v[0] === '=' || v[0] === '+=' || v[0] === '-=') ?
					`${k}${v[0]}${_json(v[1])}` :
					`${k}=${_json(v)}`
				);
			}
			onConflict = `ON DUPLICATE KEY UPDATE ${exprs.join(',')} `;
		}

		// Put parts togther
		return `INSERT INTO ${table} (${keys.join(',')}) VALUES ${strs.join(',')} ${onConflict}`;
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
				q += `ORDER BY ${options.sort.map(x => `${x.field} ${x.mode ? x.mode + ' ' : ''}${x.order || 'ASC'}`).join(',')} `;
			else
				q += `ORDER BY ${options.sort} `;
		}
		
		if (options.limit)
			q += `LIMIT ${options.limit} `;
		if (options.start)
			q += `START ${options.start} `;
		if (options.fetch)
			q += `FETCH ${options.fetch.join(',')} `;
		if (options.group)
			q += `GROUP ${typeof options.group === 'string' ? 'ALL' : 'BY ' + options.group.join(',')} `;

		return q;
	},

	/** Update statement */
	update: <T extends object>(records: string | string[], options: SqlUpdateOptions<T>) => {
		let q = `UPDATE ${typeof records === 'string' ? records : records.join(',')} `;

		// Check if SET should be used
		if ((options as _SqlUpdateSetOptions<T>).set) {
			// All must be set using merge
			const exprs: string[] = [];
			for (const [k, v] of Object.entries((options as _SqlUpdateSetOptions<T>).set)) {
				if (v === undefined) continue;

				exprs.push(Array.isArray(v) && (v[0] === '=' || v[0] === '+=' || v[0] === '-=') ?
					`${k}${v[0]}${_json(v[1])}` :
					`${k}=${_json(v)}`
				);
			}
			const set = exprs.join(',');

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


// Record class for usage in functions
export function new_Record(table: string, id: string) { return ''; }


/**
 * Create query string to call `fn::get_member`
 * 
 * @param profile_id The id of the member
 * @param domain_id The domain of the member
 */
export function getMember(profile_id: string, domain_id: string) {
	return `fn::get_member(${domain_id}, ${profile_id}) `;
}

/**
 * Create a query string to call the `fn::has_permission` function
 * 
 * @param profile_id The id of the profile to check permissions for
 * @param resource_id The resource to check permissions for
 * @param permission The permission to check for
 * @param domain_id The domain that the member and resource are in (default `${resource}.domain`)
 */
export function hasPermission(profile_id: string, resource_id: string, permission: AllPermissions, domain_id?: string) {
	domain_id = domain_id || `${resource_id}.domain`;
	return `fn::has_permission(${domain_id}, ${profile_id}, ${resource_id}, "${permission}") `;
}

/**
 * Create a query string to call the `fn::has_permission_using_member` function,
 * where a member object is passed rather than the profile and domain, as an optimization
 * 
 * @param resource_id The resource to check permissions for
 * @param permission The permission to check for
 * @param member The member object
 */
export function hasPermissionUsingMember(resource_id: string, permission: AllPermissions, member: string = '$member') {
	return `fn::has_permission_using_member(${member}, ${resource_id}, "${permission}") `;
}

/**
 * Create query string to call the `fn::has_member_permission` function
 * 
 * @param requester_id The profile id of the user performing the action
 * @param reciever_id The profile id of the user recieving the action
 * @param permission The permission to check for
 * @param domain_id The domain that the members are in
 */
export function hasMemberPermission(requester_id: string, reciever_id: string, permission: AllPermissions, domain_id: string) {
	return `fn::has_member_permission(${domain_id}, ${requester_id}, ${reciever_id}, "${permission}")`;
}

/**
 * Checks if the profile is a member of a domain
 * 
 * @param profile_id The profile to check
 * @param domain_id The domain to check
 */
export function isMember(profile_id: string, domain_id: string) {
	return `fn::is_member(${domain_id}, ${profile_id}) `;
}

/**
 * Check if a member can view an acl entry
 * 
 * @param resource_id The resource of the acl entry
 * @param role_id The role of the acl entry
 * @param member The member object to check for
 */
export function canViewAcl(resource_id: string, role_id: string, member: string = '$member') {
	return `fn::can_view_acl(${member}, ${resource_id}, ${role_id}) `;
}

/**
 * Check if a member can modify an acl entry
 * 
 * @param resource_id The resource of the acl entry
 * @param role_id The role of the acl entry
 * @param member The member object to check for
 */
export function canModifyAcl(resource_id: string, role_id: string, permissions: string, member: string = '$member') {
	return `fn::can_modify_acl(${member}, ${resource_id}, ${role_id}, ${permissions}) `;
}