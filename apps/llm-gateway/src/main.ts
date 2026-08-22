import './environment-secret';
import { config } from './config';
import { buildServer } from './server';

const { app, traces } = buildServer();

const server = Bun.serve({
  port: config.port,
  // idleTimeout DISABLED (0). Bun's default is 10s and its MAX is 255s — and
  // crucially Bun does NOT reset idleTimeout on server->client stream writes, so
  // relayStream's 10s keep-alives do NOT keep the socket alive: the timer fires
  // 255s after connection start regardless. On a slow-first-token upstream
  // (a reasoning model prefilling a very large prompt — e.g. Bedrock Claude on a
  // ~277k-token multimodal turn takes >255s to first byte) Bun aborted the
  // request signal at 255s with a TimeoutError ("The operation timed out.");
  // that signal is the SAME one handed to the upstream streamText call, so the
  // abort propagated to the provider fetch and surfaced as a 0-byte/0-token
  // empty completion. There is no 255s ceiling that is high enough here, so the
  // only correct value is 0 (disabled): the gateway governs stream lifetime
  // itself via relayStream's heartbeats + its own 90-min inactivity budget
  // (pipeline/streaming.ts INACTIVITY_TIMEOUT_MS), and a real client disconnect
  // still aborts req.signal (a separate mechanism, unaffected by idleTimeout).
  idleTimeout: 0,
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
