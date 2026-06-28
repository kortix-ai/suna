import { config } from './config';
import { buildServer } from './server';

const { app, traces } = buildServer();

const server = Bun.serve({
  port: config.port,
  // Bun's default idleTimeout is 10s: a streaming chat completion that pauses
  // longer than that between tokens (reasoning models, slow first token) gets
  // its socket killed mid-stream with an empty reply — which opencode reports as
  // "Connection reset by server". relayStream emits a keep-alive every 10s so it
  // never actually idles; this is the backstop ceiling (255 = Bun's max).
  idleTimeout: 255,
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
