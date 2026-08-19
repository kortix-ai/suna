#!/usr/bin/env bun
/**
 * Meta-agent session boot benchmark.
 *
 * `bench-boot-attribution.ts` measures ordinary sessions and needs a direct
 * Postgres connection for the host-side transitions. This one measures the
 * PLATFORM META sandbox (`sandbox_slug: 'meta'`, the `meta` runtime profile)
 * from a laptop against a deployed API, with no database access:
 *
 *   t0 ─ POST /projects/:p/sessions returns        → api_create_ms
 *      ─ GET  /sessions/:s exposes `sandbox_url`   → vm_created_ms
 *      ─ first 2xx from /kortix/health             → daemon_reachable_ms
 *      ─ health.runtimeReady === true              → runtime_ready_ms   (usable)
 *
 * plus the daemon's own `boot_timeline` (in-guest, daemon-start-relative), so a
 * boot decomposes into "waiting for the provider" vs "the guest booting itself".
 *
 * `sandbox_url` lands the moment the provider returns the VM, which is the
 * closest public proxy for the `external_id` write the DB harness watches.
 *
 * Usage:
 *   cd apps/api
 *   BENCH_API=https://dev-api.kortix.com \
 *   BENCH_TOKEN=kortix_pat_... \
 *   BENCH_PROJECT=<project with meta_agent enabled> \
 *   BENCH_ROUNDS=3 bun run scripts/bench-meta-boot.ts
 *
 * Env:
 *   BENCH_PROJECT   project id. Required. meta_agent must be enabled on it
 *                   unless BENCH_AGENT/BENCH_SLUG say otherwise.
 *   BENCH_TOKEN     kortix_pat_… Required. Environment only, never a config file.
 *   BENCH_API       API origin (default https://dev-api.kortix.com).
 *   BENCH_ROUNDS    boots per label (default 3).
 *   BENCH_LABEL     row label (default "meta").
 *   BENCH_AGENT     explicit agent for the create body (default: omitted, so
 *                   the project's meta default applies).
 *   BENCH_SLUG      explicit sandbox_slug (default: omitted).
 *   BENCH_TIMEOUT_S per-boot ceiling (default 240).
 *   BENCH_KEEP      "1" to leave the sessions behind (default: delete them).
 *   BENCH_OUT       write raw JSON here.
 */
import { writeFileSync } from 'node:fs';
import { SQL } from 'bun';

const API = (process.env.BENCH_API ?? 'https://dev-api.kortix.com').replace(/\/+$/, '');
const TOKEN = (process.env.BENCH_TOKEN ?? '').trim();
const PROJECT = (process.env.BENCH_PROJECT ?? '').trim();
const ROUNDS = Number(process.env.BENCH_ROUNDS ?? 3);
const LABEL = process.env.BENCH_LABEL ?? 'meta';
const AGENT = process.env.BENCH_AGENT ?? '';
const SLUG = process.env.BENCH_SLUG ?? '';
const TIMEOUT_MS = Number(process.env.BENCH_TIMEOUT_S ?? 240) * 1000;
const KEEP = process.env.BENCH_KEEP === '1';
// Optional. With it, the host-side marks the API already records
// (`session_sandboxes.metadata.provisionTimeline`) are merged into the client
// timeline, which is the only way to see WHERE the pre-VM seconds go: the
// public API exposes the outcome, never the stages that produced it.
const DB_URL = (process.env.BENCH_DB_URL ?? '').trim();
const sqlDb = DB_URL ? new SQL(DB_URL) : null;

if (!TOKEN || !PROJECT) {
  console.error('Need BENCH_TOKEN and BENCH_PROJECT.');
  process.exit(1);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface BootMark { label: string; atMs: number }
interface Boot {
  label: string;
  round: number;
  sessionId: string | null;
  provider: string | null;
  agent: string | null;
  slug: string | null;
  externalId: string | null;
  apiCreateMs: number | null;
  vmCreatedMs: number | null;
  daemonReachableMs: number | null;
  runtimeReadyMs: number | null;
  bootTimeline: BootMark[] | null;
  /** Wall-clock epoch of t0, so server timestamps join onto the client clock. */
  t0Epoch: number;
  sessionRowMs: number | null;
  sandboxRowMs: number | null;
  provisionMarks: { label: string; atMs: number; deltaMs: number }[] | null;
  provisionStartMs: number | null;
  error?: string;
}

function api(path: string, init?: RequestInit) {
  return fetch(`${API}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TOKEN}`,
      ...init?.headers,
    },
    signal: AbortSignal.timeout(120_000),
  });
}

/** One boot, fully attributed. Never throws — a failed boot is recorded as one. */
async function measureBoot(round: number): Promise<Boot> {
  const boot: Boot = {
    label: LABEL, round, sessionId: null, provider: null, agent: null, slug: null,
    externalId: null, apiCreateMs: null, vmCreatedMs: null,
    daemonReachableMs: null, runtimeReadyMs: null, bootTimeline: null,
    t0Epoch: Date.now(), sessionRowMs: null, sandboxRowMs: null,
    provisionMarks: null, provisionStartMs: null,
  };
  const t0 = performance.now();
  const at = () => Math.round(performance.now() - t0);

  try {
    const body: Record<string, unknown> = {};
    if (AGENT) body.agent = AGENT;
    if (SLUG) body.sandbox_slug = SLUG;
    const res = await api(`/v1/projects/${PROJECT}/sessions`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    boot.apiCreateMs = at();
    const created: any = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`create ${res.status}: ${JSON.stringify(created).slice(0, 300)}`);
    boot.sessionId = created?.session_id ?? created?.id ?? null;
    if (!boot.sessionId) throw new Error(`create returned no session id: ${JSON.stringify(created).slice(0, 300)}`);
    boot.provider = created?.sandbox_provider ?? null;
    boot.agent = created?.agent_name ?? null;
    boot.slug = created?.metadata?.sandbox_slug ?? null;

    // The health poll runs concurrently with the session poll: the guest is
    // already booting while the host is still finishing its bookkeeping, so
    // serializing the two would fold host writes into the in-guest numbers.
    let healthPolling: Promise<void> | null = null;
    const pollHealth = async (eid: string) => {
      while (performance.now() - t0 < TIMEOUT_MS) {
        try {
          const h = await fetch(`${API}/v1/p/${eid}/8000/kortix/health`, {
            headers: { Authorization: `Bearer ${TOKEN}` },
            signal: AbortSignal.timeout(10_000),
          });
          if (h.ok) {
            if (boot.daemonReachableMs === null) boot.daemonReachableMs = at();
            const hb: any = await h.json().catch(() => null);
            if (hb?.boot_timeline) boot.bootTimeline = hb.boot_timeline;
            if (hb?.runtimeReady) { boot.runtimeReadyMs = at(); return; }
          }
        } catch { /* daemon not up yet */ }
        await sleep(200);
      }
    };

    while (performance.now() - t0 < TIMEOUT_MS) {
      const r = await api(`/v1/projects/${PROJECT}/sessions/${boot.sessionId}`);
      const s: any = await r.json().catch(() => null);
      if (s?.status === 'error') throw new Error(`session error: ${s?.error ?? 'unknown'}`);
      const url: string | null = s?.sandbox_url ?? null;
      if (url && boot.vmCreatedMs === null) {
        boot.vmCreatedMs = at();
        // sandbox_url = `${API}/v1/p/<external_id>/8000`
        boot.externalId = url.split('/v1/p/')[1]?.split('/')[0] ?? null;
        if (boot.externalId) healthPolling = pollHealth(boot.externalId);
      }
      if (boot.runtimeReadyMs !== null) break;
      if (healthPolling) { await healthPolling; break; }
      await sleep(250);
    }
    if (healthPolling) await healthPolling;
    if (boot.runtimeReadyMs === null) boot.error ??= 'timeout before runtimeReady';
  } catch (err) {
    boot.error = err instanceof Error ? err.message : String(err);
  } finally {
    if (sqlDb && boot.sessionId) {
      try {
        const [row] = await sqlDb`
          select s.created_at as sess_created,
                 b.created_at as sbx_created,
                 b.metadata->'provisionTimeline' as tl
          from kortix.project_sessions s
          left join kortix.session_sandboxes b on b.sandbox_id::text = s.session_id::text
          where s.session_id::text = ${boot.sessionId} limit 1`;
        if (row) {
          const rel = (d: Date | string | null) => (d ? new Date(d).getTime() - boot.t0Epoch : null);
          boot.sessionRowMs = rel(row.sess_created);
          boot.sandboxRowMs = rel(row.sbx_created);
          boot.provisionMarks = row.tl?.marks ?? null;
          // The provision timeline is relative to its own start, which the row
          // does not store. The sandbox row is inserted inside the provision
          // call, so its created_at is the tightest anchor available.
          boot.provisionStartMs = boot.sandboxRowMs;
        }
      } catch (err) {
        console.error(`  (db harvest failed: ${err instanceof Error ? err.message : err})`);
      }
    }
    if (boot.sessionId && !KEEP) {
      await api(`/v1/projects/${PROJECT}/sessions/${boot.sessionId}`, { method: 'DELETE' }).catch(() => {});
    }
  }
  return boot;
}

function stat(values: number[]): string {
  const ok = values.filter((v) => Number.isFinite(v));
  if (!ok.length) return '—';
  const s = [...ok].sort((a, b) => a - b);
  const p = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  return `min ${(s[0] / 1000).toFixed(1)}s  p50 ${(p(0.5) / 1000).toFixed(1)}s  max ${(s[s.length - 1] / 1000).toFixed(1)}s`;
}

const boots: Boot[] = [];
for (let round = 1; round <= ROUNDS; round++) {
  const b = await measureBoot(round);
  boots.push(b);
  const ready = b.runtimeReadyMs === null ? 'FAILED' : `${(b.runtimeReadyMs / 1000).toFixed(1)}s`;
  console.error(
    `[${LABEL}] round ${round}/${ROUNDS}  ready ${ready}  provider ${b.provider}  agent ${b.agent}  slug ${b.slug}` +
      (b.error ? `  error: ${b.error}` : ''),
  );
}

console.error(`\n── ${LABEL} · ${boots.length} boots · ${API} ─────────────`);
const col = (pick: (b: Boot) => number | null) => stat(boots.map((b) => pick(b) ?? NaN));
console.error(`  api_create        ${col((b) => b.apiCreateMs)}`);
console.error(`  vm_created        ${col((b) => b.vmCreatedMs)}`);
console.error(`  daemon_reachable  ${col((b) => b.daemonReachableMs)}`);
console.error(`  runtime_ready     ${col((b) => b.runtimeReadyMs)}`);

// In-guest stage marks, daemon-start-relative. Union of labels across boots so a
// boot that skipped a stage does not silently drop it from the table.
const labels: string[] = [];
for (const b of boots) for (const m of b.bootTimeline ?? []) if (!labels.includes(m.label)) labels.push(m.label);
if (labels.length) {
  console.error(`\n  in-guest (daemon start = 0):`);
  for (const l of labels) {
    const vals = boots.map((b) => b.bootTimeline?.find((m) => m.label === l)?.atMs ?? NaN);
    console.error(`    ${l.padEnd(30)} ${stat(vals)}`);
  }
}

// One merged, t0-anchored timeline: host marks land where they actually
// happened on the client clock, so "3s of api_create" stops being opaque.
if (sqlDb) {
  const hostLabels: string[] = [];
  for (const b of boots) for (const m of b.provisionMarks ?? []) if (!hostLabels.includes(m.label)) hostLabels.push(m.label);
  if (hostLabels.length) {
    console.error(`\n  host provision (t0-anchored):`);
    console.error(`    ${'session-row-inserted'.padEnd(30)} ${stat(boots.map((b) => b.sessionRowMs ?? NaN))}`);
    console.error(`    ${'sandbox-row-inserted'.padEnd(30)} ${stat(boots.map((b) => b.sandboxRowMs ?? NaN))}`);
    for (const l of hostLabels) {
      const vals = boots.map((b) => {
        const m = b.provisionMarks?.find((x) => x.label === l);
        return m && b.provisionStartMs !== null ? b.provisionStartMs + m.atMs : NaN;
      });
      console.error(`    ${`provision:${l}`.padEnd(30)} ${stat(vals)}`);
    }
  }
}

const out = process.env.BENCH_OUT;
if (out) {
  writeFileSync(out, JSON.stringify({ api: API, project: PROJECT, label: LABEL, boots }, null, 2));
  console.error(`\nwrote ${out}`);
}
console.log(JSON.stringify({ api: API, project: PROJECT, label: LABEL, boots }));
