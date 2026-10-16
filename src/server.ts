import { createServer } from 'node:http';
import { env } from './config/env.js';
import { loadBrand } from './config/brand.js';
import { prisma } from './db/prisma.js';
import { createApp } from './app.js';
import { initSockets } from './sockets/index.js';

async function main() {
  const brand = await loadBrand();
  await prisma.$connect();

  const httpServer = createServer(createApp());
  initSockets(httpServer, env.CORS_ORIGINS);

  httpServer.listen(env.PORT, () => {
    const base = `http://localhost:${env.PORT}`;
    console.log(`\n🎫 TurnoFlow — ${brand.companyName}`);
    console.log(`   Tótem / Web : ${base}/totem.html`);
    console.log(`   Operador    : ${base}/operator.html`);
    console.log(`   TV de sala  : ${base}/display.html`);
    console.log(`   Zona horaria: ${env.APP_TIMEZONE}\n`);
  });

  const shutdown = async (signal: string) => {
    console.log(`\n${signal} recibido, cerrando…`);
    httpServer.close();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch(async (err) => {
  console.error('❌ Error al iniciar:', err);
  await prisma.$disconnect();
  process.exit(1);
});
