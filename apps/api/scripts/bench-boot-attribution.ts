#!/usr/bin/env bun
/**
 * Full-attribution session-boot benchmark.
 *
 * The older `bench-session-boot.ts` reports a single `total_ms` from polling the
 * session status — enough to say "boot is slow", useless for saying WHERE. This
 * one instruments every observable transition end to end, on both sides of the
 * VM boundary, so a boot decomposes into named stages:
 *
 *   HOST      t0 ─ POST /sessions returns              → api_create_ms
 *             ─ session_sandboxes.external_id set      → vm_created_ms   (VM exists)
 *             ─ session_sandboxes.status = 'active'    → row_active_ms
 *   IN-GUEST  ─ first 2xx from /kortix/health          → daemon_reachable_ms
 *             ─ health.runtimeReady = true             → runtime_ready_ms  (usable)
 *
 * plus the daemon's own `boot_timeline` (BootMark[]) harvested off the health
 * response — the per-stage in-guest breakdown (clone / config-deps / opencode
 * spawn / opencode session) that is otherwise unattributable because the daemon
 * never persists it.
 *
 * Host-side transitions are read straight from Postgres rather than from the
 * session API: the API's own readiness resolution is one of the things being
 * measured, and DB polling sees `external_id` land the moment provider.create
 * returns, which no public endpoint exposes.
 *
 * Usage:
 *   cd apps/api
 *   BENCH_DB_URL="$(dotenvx get DATABASE_URL -f .env.prod)" \
 *   BENCH_TOKEN=... BENCH_API=https://api.kortix.com \
 *   BENCH_TARGETS='[{"label":"daytona","workspaceId":"..."},{"label":"platinum","workspaceId":"..."}]' \
 *   bun run scripts/bench-boot-attribution.ts
 *
 * Env:
 *   BENCH_TARGETS   JSON array of {label, workspaceId}. Required.
 *   BENCH_DB_URL    Postgres URL for host-side transitions. Required.
 *   BENCH_API       API base origin (default https://api.kortix.com).
 *   BENCH_TOKEN     kortix_pat_… Required. Read from env only, never from a
 *                   config file — see the comment on TOKEN below.
 *   BENCH_ROUNDS    boots per target (default 3).
 *   BENCH_TIMEOUT_S per-boot ceiling (default 180).
 *   BENCH_KEEP      "1" to leave the sessions behind (default: delete them).
 *   BENCH_OUT       write the raw JSON here (default: stdout only).
 *
 * Boots are sequential per target and targets run in parallel, so the two
 * providers see comparable control-plane load without self-contention.
 */
import { writeFileSync } from 'node:fs';
import { SQL } from 'bun';

const API = (process.env.BENCH_API ?? 'https://api.kortix.com').replace(/\/+$/, '');
const ROUNDS = Number(process.env.BENCH_ROUNDS ?? 3);
const TIMEOUT_MS = Number(process.env.BENCH_TIMEOUT_S ?? 180) * 1000;
const KEEP = process.env.BENCH_KEEP === '1';
const DB_URL = process.env.BENCH_DB_URL ?? '';

// Token comes from the environment ONLY — deliberately not read out of
// ~/.config/kortix/config.json. Two reasons, and the second is the important one:
//   1. This harness points at whatever BENCH_API says, including production.
//      Silently pairing an explicit host with an implicitly-discovered credential
//      from a config file is how you benchmark the wrong deployment with the wrong
//      account's token. Making the credential as explicit as the target removes
//      that whole class of mistake.
//   2. It also removes a real file-data-to-outbound-request flow (CodeQL
//      js/file-data-in-outbound-request), rather than suppressing the alert.
const TOKEN = (process.env.BENCH_TOKEN ?? '').trim();

interface Target { label: string; workspaceId: string }
const TARGETS: Target[] = JSON.parse(process.env.BENCH_TARGETS ?? '[]');

if (!TARGETS.length || !DB_URL || !TOKEN) {
  console.error('Need BENCH_TARGETS, BENCH_DB_URL, and BENCH_TOKEN.');
  process.exit(1);
}

const sql = new SQL(DB_URL);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface BootMark { label: string; atMs: number }
interface Boot {
  target: string;
  round: number;
  sessionId: string | null;
  provider: string | null;
  /** Snapshot the session actually booted from — distinguishes a warm (ppwarm) image from a cold one. */
  image: string | null;
  imageKind: 'ppwarm' | 'default-cold' | 'per-project-tpl' | 'unknown';
  apiCreateMs: number | null;
  vmCreatedMs: number | null;
  rowActiveMs: number | null;
  daemonReachableMs: number | null;
  runtimeReadyMs: number | null;
  /** Host-side ProvisionTimeline marks, as persisted by the API. */
  hostMarks: Array<{ label: string; deltaMs: number }> | null;
  /** In-guest BootMark[] read off /kortix/health. */
  bootTimeline: BootMark[] | null;
  error?: string;
}

function classifyImage(ref: string | null): Boot['imageKind'] {
  if (!ref) return 'unknown';
  if (ref.startsWith('kortix-ppwarm-')) return 'ppwarm';
  if (ref.startsWith('kortix-default-')) return 'default-cold';
  if (ref.startsWith('kortix-tpl-')) return 'per-project-tpl';
  return 'unknown';
}

async function api(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${API}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}`, ...init?.headers },
    signal: AbortSignal.timeout(60_000),
  });
}

/** One boot, fully attributed. Never throws — a failed boot is recorded as one. */
async function measureBoot(target: Target, round: number): Promise<Boot> {
  const boot: Boot = {
    target: target.label, round, sessionId: null, provider: null, image: null, imageKind: 'unknown',
    apiCreateMs: null, vmCreatedMs: null, rowActiveMs: null,
    daemonReachableMs: null, runtimeReadyMs: null, hostMarks: null, bootTimeline: null,
  };
  const t0 = performance.now();
  const at = () => Math.round(performance.now() - t0);

  try {
    const res = await api(`/v1/projects/${target.workspaceId}/sessions`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    boot.apiCreateMs = at();
    const body: any = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`create ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
    const sessionId = body?.id ?? body?.session_id ?? body?.sessionId;
    if (!sessionId) throw new Error(`create returned no session id: ${JSON.stringify(body).slice(0, 300)}`);
    boot.sessionId = sessionId;

    let externalId: string | null = null;
    let healthPolling: Promise<void> | null = null;

    // Once the VM exists, poll the daemon concurrently with the DB — the guest
    // boots while the host is still finishing its row writes, so serializing the
    // two would fold host bookkeeping into the in-guest numbers.
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
      const rows = await sql`
        select provider::text as provider, external_id, status::text as status, metadata
        from kortix.session_sandboxes where sandbox_id = ${sessionId} limit 1`;
      const row = rows[0];
      if (row) {
        boot.provider = row.provider;
        if (row.external_id && boot.vmCreatedMs === null) {
          boot.vmCreatedMs = at();
          externalId = row.external_id;
          healthPolling = pollHealth(externalId!);
        }
        if (row.status === 'active' && boot.rowActiveMs === null) boot.rowActiveMs = at();
        const md = row.metadata ?? {};
        if (md.provisionTimeline?.marks) boot.hostMarks = md.provisionTimeline.marks;
        const ref = md.runtimeArtifact?.providerArtifactRef ?? null;
        if (ref) { boot.image = ref; boot.imageKind = classifyImage(ref); }
        if (row.status === 'error') throw new Error(`sandbox error: ${md.lastInitError ?? 'unknown'}`);
      }
      if (boot.runtimeReadyMs !== null) break;
      // Stop DB polling once the host side is fully settled; the health poll owns
      // the rest of the wall clock.
      if (boot.rowActiveMs !== null && externalId) { await healthPolling; break; }
      await sleep(100);
    }
    if (healthPolling) await healthPolling;
    if (boot.runtimeReadyMs === null) boot.error = 'timeout before runtimeReady';
  } catch (err) {
    boot.error = err instanceof Error ? err.message : String(err);
  } finally {
    if (boot.sessionId && !KEEP) {
      await api(`/v1/projects/${target.workspaceId}/sessions/${boot.sessionId}`, { method: 'DELETE' }).catch(() => {});
    }
  }
  return boot;
}

function pct(values: number[], p: number): number {
  if (!values.length) return -1;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.max(0, Math.min(Math.ceil((p / 100) * s.length) - 1, s.length - 1))];
}

/** Guest marks are cumulative (`atMs` since daemon start) — difference them into per-stage costs. */
function guestDeltas(timeline: BootMark[]): Array<{ label: string; deltaMs: number }> {
  let prev = 0;
  return timeline.map((m) => { const d = m.atMs - prev; prev = m.atMs; return { label: m.label, deltaMs: d }; });
}

function report(boots: Boot[]): void {
  const byTarget = new Map<string, Boot[]>();
  for (const b of boots) {
    if (!byTarget.has(b.target)) byTarget.set(b.target, []);
    byTarget.get(b.target)!.push(b);
  }

  for (const [label, all] of byTarget) {
    const ok = all.filter((b) => b.runtimeReadyMs !== null);
    console.error(`\n━━━ ${label} — ${ok.length}/${all.length} booted ━━━`);
    for (const b of all) {
      console.error(
        `  r${b.round} ${b.error ? `FAILED: ${b.error}` : ''}` +
        (b.runtimeReadyMs !== null
          ? `api=${b.apiCreateMs}ms vm=${b.vmCreatedMs}ms active=${b.rowActiveMs}ms ` +
            `daemon=${b.daemonReachableMs}ms READY=${b.runtimeReadyMs}ms [${b.imageKind}]`
          : ''),
      );
    }
    if (!ok.length) continue;

    const stage = (pick: (b: Boot) => number | null) => {
      const v = ok.map(pick).filter((n): n is number => n !== null);
      return v.length ? `p50=${pct(v, 50)}ms p90=${pct(v, 90)}ms max=${Math.max(...v)}ms` : '—';
    };
    console.error(`  cumulative (t0 = POST /sessions):`);
    console.error(`    api-create       ${stage((b) => b.apiCreateMs)}`);
    console.error(`    vm-created       ${stage((b) => b.vmCreatedMs)}`);
    console.error(`    row-active       ${stage((b) => b.rowActiveMs)}`);
    console.error(`    daemon-reachable ${stage((b) => b.daemonReachableMs)}`);
    console.error(`    RUNTIME-READY    ${stage((b) => b.runtimeReadyMs)}`);

    const guest = new Map<string, number[]>();
    for (const b of ok) {
      if (!b.bootTimeline) continue;
      for (const m of guestDeltas(b.bootTimeline)) {
        if (!guest.has(m.label)) guest.set(m.label, []);
        guest.get(m.label)!.push(m.deltaMs);
      }
    }
    if (guest.size) {
      console.error(`  in-guest stages (per-stage cost):`);
      for (const [lbl, v] of guest) {
        console.error(`    ${lbl.padEnd(26)} p50=${String(pct(v, 50)).padStart(6)}ms p90=${String(pct(v, 90)).padStart(6)}ms max=${String(Math.max(...v)).padStart(6)}ms`);
      }
    }
    const host = new Map<string, number[]>();
    for (const b of ok) {
      for (const m of b.hostMarks ?? []) {
        const key = m.label.replace(/\d+x/, 'Nx');
        if (!host.has(key)) host.set(key, []);
        host.get(key)!.push(m.deltaMs);
      }
    }
    if (host.size) {
      console.error(`  host stages (per-stage cost):`);
      for (const [lbl, v] of host) {
        console.error(`    ${lbl.padEnd(26)} p50=${String(pct(v, 50)).padStart(6)}ms p90=${String(pct(v, 90)).padStart(6)}ms max=${String(Math.max(...v)).padStart(6)}ms`);
      }
    }
    const kinds = ok.reduce<Record<string, number>>((a, b) => ((a[b.imageKind] = (a[b.imageKind] ?? 0) + 1), a), {});
    console.error(`  image kinds: ${JSON.stringify(kinds)}`);
  }
}

async function main() {
  console.error(`session-boot attribution — API ${API}, ${ROUNDS} rounds/target`);
  console.error(`targets: ${TARGETS.map((t) => `${t.label}(${t.workspaceId.slice(0, 8)})`).join(', ')}\n`);

  const results = await Promise.all(
    TARGETS.map(async (t) => {
      const out: Boot[] = [];
      for (let r = 1; r <= ROUNDS; r++) {
        console.error(`[${t.label}] round ${r}/${ROUNDS} …`);
        out.push(await measureBoot(t, r));
      }
      return out;
    }),
  );
  const boots = results.flat();
  report(boots);

  const json = JSON.stringify({ api: API, rounds: ROUNDS, boots }, null, 1);
  if (process.env.BENCH_OUT) {
    writeFileSync(process.env.BENCH_OUT, json);
    console.error(`\nraw → ${process.env.BENCH_OUT}`);
  } else {
    console.log(json);
  }
  await sql.close();
}

main().catch(async (err) => {
  console.error(err);
  await sql.close().catch(() => {});
  process.exit(1);
});
