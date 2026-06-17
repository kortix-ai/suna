import { config } from './config';
import { buildServer } from './server';

const { app, traces } = buildServer();

const server = Bun.serve({
  port: config.port,
  fetch: app.fetch,
});

console.log(`[gateway] listening on :${server.port}`);

const shutdown = async () => {
  server.stop();
  if (traces) await traces.shutdown();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
