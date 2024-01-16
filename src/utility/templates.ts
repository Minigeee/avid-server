import { AclEntry, Channel, ChannelGroup, Wiki } from '@app/types';
import { sql } from './query';
import { DEFAULT_GROUP_PERMISSIONS } from '../routes/channel_groups';

/** Template modules */
const TEMPLATE_MODULES = {
  /** The main group of default template */
  default_main: (name: `$${string}`) => [
    // Create new group
    sql.let(
      name,
      sql.create<ChannelGroup>(
        'channel_groups',
        {
          domain: sql.$('$domain.id'),
          name: 'Main',
          channels: sql.$('[]'),
        },
        { single: true },
      ),
    ),

    // Create channels
    sql.let(
      '$welcome',
      sql.wrap(
        sql.create<Channel>(
          'channels',
          {
            domain: sql.$('$domain.id'),
            inherit: sql.$(`(${name}.id)`),
            name: 'Welcome',
            type: 'wiki',
          },
          { single: true, return: ['id'] },
        ),
        { append: '.id' },
      ),
    ),
    sql.let(
      '$calendar',
      sql.wrap(
        sql.create<Channel>(
          'channels',
          {
            domain: sql.$('$domain.id'),
            inherit: sql.$(`(${name}.id)`),
            name: 'Calendar',
            type: 'calendar',
          },
          { single: true, return: ['id'] },
        ),
        { append: '.id' },
      ),
    ),
    sql.let(
      '$announcements',
      sql.wrap(
        sql.create<Channel>(
          'channels',
          {
            domain: sql.$('$domain.id'),
            inherit: sql.$(`(${name}.id)`),
            name: 'Announcements',
            type: 'text',
          },
          { single: true, return: ['id'] },
        ),
        { append: '.id' },
      ),
    ),
    sql.let(
      '$lobby',
      sql.wrap(
        sql.create<Channel>(
          'channels',
          {
            domain: sql.$('$domain.id'),
            inherit: sql.$(`(${name}.id)`),
            name: 'Lobby',
            type: 'text',
          },
          { single: true, return: ['id'] },
        ),
        { append: '.id' },
      ),
    ),

    // Content
    `CREATE type::thing("wikis", string::split(type::string($welcome), ":")[1]) CONTENT (${sql.select<Wiki>(
      ['*', 'NONE AS id'],
      {
        from: 'wikis:_default_main_welcome',
        single: true,
      },
    )}) `,

    // Set channels
    sql.update<ChannelGroup>(`(${name}.id)`, {
      set: {
        channels: sql.$(`[$welcome, $calendar, $announcements, $lobby]`),
      },
    }),

    // Set permissions
    sql.create<AclEntry>('acl', {
      domain: sql.$('$domain.id'),
      resource: sql.$(`(${name}.id)`),
      role: sql.$('$role.id'),
      permissions: DEFAULT_GROUP_PERMISSIONS,
    }),
  ],

  /** Avid intro tutorial */
  default_avid: (name: `$${string}`) => [
    // Create new group
    sql.let(
      name,
      sql.create<ChannelGroup>(
        'channel_groups',
        {
          domain: sql.$('$domain.id'),
          name: 'Avid',
          channels: sql.$('[]'),
        },
        { single: true },
      ),
    ),

    // Create channels
    sql.let(
      '$introduction',
      sql.wrap(
        sql.create<Channel>(
          'channels',
          {
            domain: sql.$('$domain.id'),
            inherit: sql.$(`(${name}.id)`),
            name: 'Introduction',
            type: 'wiki',
          },
          { single: true, return: ['id'] },
        ),
        { append: '.id' },
      ),
    ),
    sql.let(
      '$setup',
      sql.wrap(
        sql.create<Channel>(
          'channels',
          {
            domain: sql.$('$domain.id'),
            inherit: sql.$(`(${name}.id)`),
            name: 'Setting Up',
            type: 'wiki',
          },
          { single: true, return: ['id'] },
        ),
        { append: '.id' },
      ),
    ),

    // Content
    `CREATE type::thing("wikis", string::split(type::string($introduction), ":")[1]) CONTENT (${sql.select<Wiki>(
      ['*', 'NONE AS id'],
      {
        from: 'wikis:_default_avid_introduction',
        single: true,
      },
    )}) `,
    `CREATE type::thing("wikis", string::split(type::string($setup), ":")[1]) CONTENT (${sql.select<Wiki>(
      ['*', 'NONE AS id'],
      {
        from: 'wikis:_default_avid_setup',
        single: true,
      },
    )}) `,

    // Set channels
    sql.update<ChannelGroup>(`(${name}.id)`, {
      set: {
        channels: sql.$(`[$introduction, $setup]`),
      },
    }),

    // No default permissions
  ],
};

/** Domain templates */
export const TEMPLATES = {
  /** Default template */
  default: () => [
    ...TEMPLATE_MODULES.default_main('$main_group'),
    ...TEMPLATE_MODULES.default_avid('$avid_group'),
    sql.let('$groups', '[$main_group.id, $avid_group.id]'),
  ],
};
