import assert from 'assert';

import {
  Board,
  Domain,
  ExpandedMember,
  ExpandedProfile,
  Member,
  Profile,
  Task,
  Thread,
  User,
} from '@app/types';

import config from '../config';
import { hasPermission, query, sql } from '../utility/query';
import { ApiRoutes } from '../utility/routes';
import {
  asArray,
  asBool,
  asInt,
  asRecord,
  isArray,
  isBool,
  isRecord,
  sanitizeHtml,
} from '../utility/validate';
import { MEMBER_SELECT_FIELDS } from './members';

import { isNil, pick, omitBy } from 'lodash';

const routes: ApiRoutes<`${string} /profiles${string}`> = {
  'GET /profiles': {
    validate: {
      ids: {
        required: true,
        location: 'query',
        transform: (value) =>
          asArray(value, (value) => asRecord('profiles', value), {
            maxlen: 1000,
          }),
      },
    },
    permissions: (req) =>
      sql.multi([
        sql.let('$profiles', `[${req.query.ids.join(',')}]`),
        sql.let(
          '$requester',
          `SELECT VALUE out FROM ${req.token.profile_id}->member_of`,
        ),
        sql.return(
          `array::all(SELECT VALUE out CONTAINSANY $requester FROM (SELECT out FROM $profiles->member_of))`,
        ),
      ]),
    code: async (req, res) => {
      const results = await query<Profile[]>(
        sql.select<Profile>('*', {
          from: req.query.ids,
        }),
      );
      assert(results);

      return results;
    },
  },

  'GET /profiles/:profile_id': {
    validate: {
      profile_id: {
        required: true,
        location: 'params',
        transform: (value) => asRecord('profiles', value),
      },
      with_domains: {
        required: false,
        location: 'query',
        transform: asBool,
      },
    },
    permissions: (req) =>
      sql.return(
        `${req.params.profile_id} == ${req.token.profile_id} || (SELECT VALUE out FROM ${req.params.profile_id}->member_of) CONTAINSANY (SELECT VALUE out FROM ${req.token.profile_id}->member_of)`,
      ),
    code: async (req, res) => {
      const results = await query<ExpandedProfile[]>(
        sql.select(
          [
            '*',
            req.query.with_domains
              ? sql.wrap(
                  sql.select<Domain>(
                    ['id', 'name', 'icon', 'quote', 'time_created'],
                    { from: '->member_of->domains' },
                  ),
                  { alias: 'domains' },
                )
              : undefined,
          ],
          { from: req.params.profile_id },
        ),
        { log: req.log },
      );
      assert(results && results.length > 0);

      return {
        ...results[0],
        // TODO : Make domains draggable
        domains: results[0].domains?.sort(
          (a: Domain, b: Domain) =>
            new Date(a.time_created).getTime() -
            new Date(b.time_created).getTime(),
        ),
      };
    },
  },
};

export default routes;
