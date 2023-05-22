

const dev_mode = process.env.NODE_ENV === 'development';


const config = {
    dev_mode,

    /** Domain info config */
    domains: {
        api: dev_mode ? 'http://localhost:3001' : 'https://api.avidapp.io',
        site: dev_mode ? 'http://localhost:3000' : 'https://avidapp.io',
    },
    
	/** Logger configuration */
	logger: {
		/** Mode the logger should operate under */
		mode: dev_mode ? 'local' : 'remote',
		/** Indicates if log files are enabled */
		log_file: !dev_mode,
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
		url: dev_mode ? 'http://127.0.0.1:8000/sql' : 'https://db.avidapp.io',
		/** Default namespace */
		namespace: dev_mode ? 'test' : 'main',
		/** Default databse */
		database: dev_mode ? 'test' : 'main',
		/** Default token */
		token: dev_mode ? 'main' : 'client',

        /** The default amount of time (in seconds) data retrieved from the database can be cached */
        cache_lifetime: 1 * 60,
	},
};

export default config;