import { readFileSync } from 'fs';

const _keys = {
	'jwt-public': '',
};


/**
 * Get the public key for signing jwt
 * 
 * @returns The public key for signing jwt
 */
export function getJwtPublic() {
	if (!_keys['jwt-public'])
		_keys['jwt-public'] = readFileSync(`credentials/${process.env.NODE_ENV}/jwt-public.key`, { encoding: 'utf8' });

	return _keys['jwt-public'];
}