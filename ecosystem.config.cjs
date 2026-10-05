module.exports = {
	apps: [
		{
			name: 'mcp-retriever',
			script: '/opt/mcp-retriever/start-server.sh',
			cwd: '/opt/mcp-retriever',
			interpreter: '/bin/bash',
			env: {
				PATH: process.env.PATH,
				HOME: process.env.HOME,
			},
			autorestart: true,
			min_uptime: 10000,
			max_restarts: 10,
			restart_delay: 2000,
			kill_timeout: 10000,
			max_memory_restart: '512M',
			error_file: '/home/ubuntu/.pm2/logs/mcp-retriever-error.log',
			out_file: '/home/ubuntu/.pm2/logs/mcp-retriever-out.log',
			log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
		},
	],
};
