import './environment-secret';
import { config } from './config';
import { bunRequestBodyCeilingBytes } from './request-body-ceiling';
import { buildServer, perRequestCapBytes } from './server';

const { app, traces, inflightRequests } = buildServer();

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
  // Bun's own body ceiling, kept above the pipeline's per-request cap so an
  // over-limit body is refused by the pipeline (logged, typed 413) and never
  // by Bun (silent plain-text 413 / mid-upload socket close). See
  // request-body-ceiling.ts.
  maxRequestBodySize: bunRequestBodyCeilingBytes(perRequestCapBytes),
  fetch: app.fetch,
});

console.log(`[gateway] listening on :${server.port}`);

// Drain before exit. ECS/Kubernetes send SIGTERM, then SIGKILL after the stop
// timeout; a Spot reclaim and every rolling deploy do the same. Exiting
// immediately (what this did until 2026-08-24) cut every in-flight LLM stream
// mid-frame — the client saw a truncated SSE body with no error, which is
// indistinguishable from a model that stopped talking.
//
// The budget is deliberately shorter than the platform's stop timeout so the
// process always exits on its own terms rather than being killed.
const DRAIN_BUDGET_MS = Number(process.env.GATEWAY_DRAIN_MS) || 25_000;
const DRAIN_POLL_MS = 250;

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  // Stop accepting new connections; keep serving the ones already open.
  server.stop();
  const deadline = Date.now() + DRAIN_BUDGET_MS;
  let remaining = inflightRequests();
  if (remaining > 0)
    console.log(
      `[gateway] draining ${remaining} in-flight request(s), budget ${DRAIN_BUDGET_MS}ms`,
    );
  while (remaining > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, DRAIN_POLL_MS));
    remaining = inflightRequests();
  }
  if (remaining > 0)
    console.warn(`[gateway] drain budget expired with ${remaining} request(s) still in flight`);
  else console.log('[gateway] drained cleanly');
  if (traces) await traces.shutdown();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
