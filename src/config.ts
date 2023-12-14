import { Algorithm } from 'jsonwebtoken';

const dev_mode = process.env.NODE_ENV === 'development';

const config = {
  dev_mode,

  /** Domain info config */
  domains: {
    api: dev_mode ? 'http://localhost:3001' : 'https://api.avidapp.io',
    site: dev_mode ? 'http://localhost:3000' : 'https://avidapp.io',
    cors: dev_mode
      ? ['http://localhost:3000']
      : ['https://avidapp.io', 'https://www.avidapp.io'],
  },

  /** Authorization config */
  auth: {
    /** Token cookie name */
    cookie_name: 'sid',
    /** Max id token (and cookie) age in seconds */
    max_id_token_age: 14 * 24 * 60 * 60,
    /** Max access token age in seconds */
    max_access_token_age: 1 * 24 * 60 * 60,

    /** JWT signing algorithm */
    jwt_algorithm: 'RS256' as Algorithm,
  },

  /** Logger configuration */
  logger: {
    /** Mode the logger should operate under */
    mode: dev_mode ? 'local' : 'remote',
    /** Indicates if log files are enabled */
    log_file: true,
    /** The log levels at or above which log entry ids should be assigned */
    id_level: 2, // "info"
    /** The log levels at or above which should be saved to remote database */
    remote_level: 0, // "error"

    /** Discord webhook used for error notifications */
    discord_webhook: process.env.DISCORD_WEBHOOK,
    /** Discord role id that should be pinged on new error */
    discord_role_id: '',
  },

  /** Database config */
  db: {
    /** Database url */
    url: dev_mode ? 'http://127.0.0.1:8000' : 'https://db.avidapp.io',
    /** Default namespace */
    namespace: dev_mode ? 'test' : 'main',
    /** Default databse */
    database: dev_mode ? 'test' : 'main',
    /** Default token */
    token: dev_mode ? 'main' : 'client',

    /** Main username */
    username: dev_mode ? 'root' : process.env.SURREAL_USERNAME,
    /** Main password */
    password: dev_mode ? 'root' : process.env.SURREAL_PASSWORD,

    /** The default amount of time (in seconds) data retrieved from the database can be cached */
    cache_lifetime: 1 * 60,

    /** Page sizes */
    page_size: {
      members: 100,
      messages: 50,
      threads: 30,
    },
  },

  /** App config */
  app: {
    /** Project board config */
    board: {
      /** Default tag color */
      default_tag_color: '#495057',

      /** Default statuses */
      default_statuses: [
        { id: 'todo', label: 'To Do', color: '#868E96' },
        { id: 'in-progress', label: 'In Progress', color: '#228BE6' },
        { id: 'completed', label: 'Completed', color: '#40C057' },
      ],
      /** Defualt status id */
      default_status_id: 'todo',

      /** Default backlog */
      backlog_collection: {
        id: 'backlog',
        name: 'Backlog',
        description:
          'A backlog is typically used as a collection of tasks, features, or issues ' +
          'that have not yet been completed. The backlog can be used in many different ways, but ' +
          'the most common way is to pull tasks from the backlog into a separate collection of tasks ' +
          'that is worked on during the current period. This process can be started ' +
          'by creating a new "objective" collection, define your team\'s current focus and priorities in its description, ' +
          'then move any task that belongs within that objective into it.',
      },
      /** All collection */
      all_collection: {
        value: 'all',
        id: 'all',
        label: 'All',
        name: 'All',
        description: 'All tasks in this board',
      },
    },
  },
};

export default config;
