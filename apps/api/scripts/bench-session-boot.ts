#!/usr/bin/env bun
/**
 * Phase 0 benchmark harness for the session-boot 1-second threshold (goal §1).
 *
 * Times session boot (create → runtime-ready) N times against a live Kortix
 * deployment, aggregates P50/P95/P99, and prints a numbers table. This is
 * MEASUREMENT ONLY — no optimization, no behavior change. The numbers this
 * produces unblock the entire session-boot-1s workstream (see
 * docs/specs/2026-07-19-session-boot-1s-threshold.md).
 *
 * Usage:
 *   cd apps/api && bun run scripts/bench-session-boot.ts
 *
 * Env:
 *   KORTIX_API_URL       — the API base URL (default: https://api.kortix.com/v1)
 *   KORTIX_CLI_TOKEN     — auth token (or KORTIX_TOKEN)
 *   KORTIX_PROJECT_ID    — project to start sessions in
 *   BENCH_ROUNDS         — number of boot measurements (default: 10)
 *   BENCH_CONCURRENCY    — parallel sessions (default: 1; >1 stresses the pool)
 *   BENCH_TIMEOUT_S      — per-session timeout (default: 120)
 *   BENCH_WARM           — "1" to skip the first (cold) boot (default: "0")
 *
 * Output: JSON on stdout (machine-readable) + a human table on stderr.
 *
 * Untested — run manually once against staging before relying on the numbers.
 */
import { performance } from 'node:perf_hooks';

const API_URL = process.env.KORTIX_API_URL ?? 'https://api.kortix.com/v1';
const TOKEN = process.env.KORTIX_CLI_TOKEN ?? process.env.KORTIX_TOKEN ?? '';
const PROJECT_ID = process.env.KORTIX_PROJECT_ID ?? '';
const ROUNDS = Number(process.env.BENCH_ROUNDS ?? 10);
const CONCURRENCY = Number(process.env.BENCH_CONCURRENCY ?? 1);
const TIMEOUT_S = Number(process.env.BENCH_TIMEOUT_S ?? 120);
const SKIP_COLD = process.env.BENCH_WARM === '1';

if (!TOKEN || !PROJECT_ID) {
  console.error('Missing KORTIX_CLI_TOKEN/KORTIX_TOKEN or KORTIX_PROJECT_ID.');
  process.exit(1);
}

interface BootResult {
  round: number;
  cold: boolean;
  createMs: number;
  readyMs: number;
  totalMs: number;
  status: string;
  error?: string;
}

async function fetchJson(url: string, init?: RequestInit): Promise<any> {
  const res = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}`, ...init?.headers },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${res.status} ${url}: ${JSON.stringify(body)}`);
  return body;
}

async function startSession(): Promise<{ sessionId: string }> {
  const body = await fetchJson(`${API_URL}/projects/${PROJECT_ID}/sessions`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  return { sessionId: body.id ?? body.session_id ?? body.sessionId };
}

async function getSession(sessionId: string): Promise<any> {
  return fetchJson(`${API_URL}/projects/${PROJECT_ID}/sessions/${sessionId}`);
}

async function stopSession(sessionId: string): Promise<void> {
  await fetchJson(`${API_URL}/projects/${PROJECT_ID}/sessions/${sessionId}`, {
    method: 'DELETE',
  }).catch(() => {});
}

async function measureBoot(round: number, cold: boolean): Promise<BootResult> {
  const t0 = performance.now();
  let sessionId = '';
  try {
    const { sessionId: sid } = await startSession();
    sessionId = sid;
    const createMs = performance.now() - t0;

    const deadline = t0 + TIMEOUT_S * 1000;
    let status = 'pending';
    while (performance.now() < deadline) {
      const session = await getSession(sid);
      status = session.status ?? session.state ?? 'unknown';
      if (status === 'ready' || status === 'ok') break;
      if (status === 'failed' || status === 'error') throw new Error(`session ${status}`);
      await new Promise((r) => setTimeout(r, 500)); // 500ms poll
    }
    const readyMs = performance.now() - t0;
    const totalMs = readyMs;
    if (status !== 'ready' && status !== 'ok') throw new Error(`timeout: ${status}`);

    return { round, cold, createMs, readyMs, totalMs, status };
  } catch (err) {
    return {
      round,
      cold,
      createMs: performance.now() - t0,
      readyMs: -1,
      totalMs: -1,
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (sessionId) await stopSession(sessionId);
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return -1;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}

async function main() {
  console.error(`\n=== session boot benchmark ===`);
  console.error(`API: ${API_URL}`);
  console.error(`Project: ${PROJECT_ID}`);
  console.error(`Rounds: ${ROUNDS} (concurrency: ${CONCURRENCY}, timeout: ${TIMEOUT_S}s, skip cold: ${SKIP_COLD})\n`);

  const results: BootResult[] = [];
  const rounds = Array.from({ length: ROUNDS }, (_, i) => i);

  // Optionally skip round 0 (cold) — the first boot warms the snapshot cache.
  const toMeasure = SKIP_COLD ? rounds.slice(1) : rounds;

  for (let i = 0; i < toMeasure.length; i += CONCURRENCY) {
    const batch = toMeasure.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map((r) => measureBoot(r + 1, r === 0 && !SKIP_COLD)),
    );
    results.push(...batchResults);
    for (const r of batchResults) {
      console.error(
        `  round ${String(r.round).padStart(3)}  ${r.cold ? 'cold' : 'warm'}  ` +
        `create=${r.createMs.toFixed(0)}ms  ready=${r.readyMs > 0 ? r.readyMs.toFixed(0) + 'ms' : '—'}  ` +
        `total=${r.totalMs > 0 ? r.totalMs.toFixed(0) + 'ms' : '—'}  ${r.status}${r.error ? '  ' + r.error : ''}`,
      );
    }
  }

  const ok = results.filter((r) => r.totalMs > 0);
  const totals = ok.map((r) => r.totalMs).sort((a, b) => a - b);
  const creates = ok.map((r) => r.createMs).sort((a, b) => a - b);

  const summary = {
    api: API_URL,
    project: PROJECT_ID,
    rounds: ROUNDS,
    succeeded: ok.length,
    failed: results.length - ok.length,
    total_ms: totals.length
      ? { p50: percentile(totals, 50), p95: percentile(totals, 95), p99: percentile(totals, 99), min: totals[0], max: totals[totals.length - 1] }
      : null,
    create_ms: creates.length
      ? { p50: percentile(creates, 50), p95: percentile(creates, 95), p99: percentile(creates, 99) }
      : null,
    one_second_threshold: totals.length ? { met: percentile(totals, 95) < 1000, p95_ms: percentile(totals, 95) } : null,
    results,
  };

  console.error(`\n=== summary ===`);
  if (totals.length) {
    console.error(`  total: P50=${(percentile(totals, 50)).toFixed(0)}ms  P95=${(percentile(totals, 95)).toFixed(0)}ms  P99=${(percentile(totals, 99)).toFixed(0)}ms  min=${totals[0].toFixed(0)}ms  max=${(totals[totals.length - 1]).toFixed(0)}ms`);
    console.error(`  create: P50=${(percentile(creates, 50)).toFixed(0)}ms  P95=${(percentile(creates, 95)).toFixed(0)}ms`);
    const p95 = percentile(totals, 95);
    console.error(`  1s threshold (P95 < 1000ms): ${p95 < 1000 ? '✅ MET' : '❌ NOT MET'} (${p95.toFixed(0)}ms)`);
  } else {
    console.error(`  no successful boots — check errors above`);
  }

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
