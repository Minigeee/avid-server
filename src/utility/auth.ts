import jwt from 'jsonwebtoken';

import { AccessToken } from '@app/types';
import { getJwtPublic } from './keys';


///////////////////////////////////////////////////////////
export function getSessionUser(token?: string) {
    if (!token) return;

    try {
        const payload = jwt.verify(token, getJwtPublic());
        return payload as AccessToken;
    }
    catch (error) {
        return;
    }
}