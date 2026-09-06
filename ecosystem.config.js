module.exports = {
  apps: [
    {
      name: "discord-to-telegram-mirror",
      script: "index.js",
      exec_mode: "fork",
      watch: false,

      max_memory_restart: "550M",
      node_args: "--max-old-space-size=512 --expose-gc",
      autorestart: true,
      exp_backoff_restart_delay: 100,
      restart_delay: 2000,
      kill_timeout: 3000,
      cron_restart: "0 */12 * * *",
      env: {
        NODE_ENV: "production",
      }
    },
    {
      name: "nexus-dashboard-tunnel",
      script: "tunnel.js",
      watch: false,
      autorestart: true,
      max_restarts: 20,
      restart_delay: 5000
    }
  ]
};

