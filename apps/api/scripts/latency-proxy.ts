#!/usr/bin/env bun
/**
 * TCP relay that delays every chunk by a fixed one-way time, so RTT = 2 x delay.
 *
 * Put it in front of a local Postgres or Supabase to give a local API the
 * database distance a deployed API has (dev: API us-west-2, DB us-east-2,
 * ~50 ms RTT). postgres.js pays ~2 round trips per statement, so the API's
 * statement count becomes wall time, as it does on dev.
 *
 *   bun apps/api/scripts/latency-proxy.ts <listenPort> <upstreamHost> <upstreamPort> <oneWayMs>
 *
 * Runbook: .agents/skills/testing/references/api-latency-baseline.md
 */
import { connect, createServer, type Socket } from 'node:net';

const [listenPort, host, upstreamPort, delay] = process.argv.slice(2);
const oneWayMs = Number(delay);
if (!listenPort || !host || !upstreamPort || !Number.isFinite(oneWayMs) || oneWayMs < 0) {
  console.error('usage: latency-proxy.ts <listenPort> <upstreamHost> <upstreamPort> <oneWayMs>');
  process.exit(2);
}

// Timers with the same delay fire in insertion order, so the byte stream keeps
// its order. `write` buffers, so a slow reader never drops bytes.
function relay(from: Socket, to: Socket): void {
  from.on('data', (chunk) => {
    const copy = Buffer.from(chunk);
    setTimeout(() => to.write(copy), oneWayMs);
  });
  from.on('close', () => setTimeout(() => to.end(), oneWayMs));
  from.on('error', () => to.destroy());
}

createServer((client) => {
  const upstream = connect(Number(upstreamPort), host);
  relay(client, upstream);
  relay(upstream, client);
}).listen(Number(listenPort), '127.0.0.1', () => {
  console.log(`latency-proxy 127.0.0.1:${listenPort} -> ${host}:${upstreamPort}, one-way ${oneWayMs} ms (RTT ${2 * oneWayMs} ms)`);
});
