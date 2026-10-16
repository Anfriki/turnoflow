/**
 * PM2 — producción en VPS.
 *   npm run build
 *   pm2 start ecosystem.config.cjs
 *   pm2 save && pm2 startup
 *
 * IMPORTANTE: una sola instancia (fork). Para varias instancias / cluster
 * hay que agregar @socket.io/redis-adapter (ver README → Escalado).
 */
module.exports = {
  apps: [
    {
      name: 'turnoflow',
      script: 'dist/src/server.js',
      instances: 1,
      exec_mode: 'fork',
      env: { NODE_ENV: 'production' },
      max_memory_restart: '400M',
      time: true,
    },
  ],
};
