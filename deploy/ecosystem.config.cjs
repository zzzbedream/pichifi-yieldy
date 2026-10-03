// pm2 process file for the agent: `pm2 start deploy/ecosystem.config.cjs && pm2 save`.
// Secrets come from the repo-root .env (loaded by agent/src/main.ts), never from this file.
module.exports = {
  apps: [
    {
      name: 'ayv-agent',
      cwd: __dirname + '/../agent',
      script: 'node_modules/.bin/tsx',
      args: 'src/main.ts',
      env: { NODE_ENV: 'production', DATA_DIR: 'data/robinhood-testnet' },
      autorestart: true,
      max_restarts: 20,
      restart_delay: 3000,
      out_file: __dirname + '/../agent/data/agent.out.log',
      error_file: __dirname + '/../agent/data/agent.err.log',
      time: true,
    },
  ],
};
