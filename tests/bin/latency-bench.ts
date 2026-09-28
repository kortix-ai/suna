#!/usr/bin/env bun
/**
 * Turn-latency benchmark — the turn-latency spec (PR #7840) §5 acceptance:
 *
 *   pnpm test -- --latency --target <origin>
 *
 * Measures a warm turn's real send-path latency against a DEPLOYED target,
 * end to end: send -> delivered, delivered -> model start, model generation,
 * completion -> return, plus the API's own pre-flight stage breakdown (the
 * `Server-Timing: turnstage-*` entries `apps/api/src/lib/server-timing.ts`
 * emits — see that module and `sandbox-proxy/routes/preview.ts`). Enforces
 * §2's budget, REGION-AWARE: dev runs the API and its database in different
 * AWS regions, and the 150ms colocated bar is meaningless against ~100-250ms
 * cross-region round trips that have nothing to do with the code path (see
 * `resolveWarmTurnBudget` in `../src/core/latency-budget.ts`).
 *
 * ─── Scope: measures an EXISTING warm session, does not provision one ──────
 * Create a throwaway dev project + session with the real CLI first (never
 * against prod — a turn started there is a real, billed action):
 *
 *   env -u KORTIX_TOKEN kortix projects create --host kortix-internal-dev ...
 *   env -u KORTIX_TOKEN kortix sessions create --host kortix-internal-dev ...
 *
 * then point this tool at it. The Kortix session id IS the sandbox's external
 * id (CLAUDE.md: "session_id == sandbox_id") — that is `--sandbox-id` below.
 *
 *   KE2E_LATENCY_TARGET=https://dev-api.kortix.com \
 *   KE2E_LATENCY_TOKEN=<bearer token> \
 *   KE2E_LATENCY_SANDBOX_ID=<sandbox/session id> \
 *   bun tests/bin/latency-bench.ts --iterations 5
 *
 * Every flag has a KE2E_LATENCY_* env equivalent; a flag wins when both are
 * given. `--target` also accepts a bare KE2E_LATENCY_TARGET env var so the
 * local-runner lane (`bun tests/bin/latency-bench.ts --target <origin>`,
 * wired in `../src/core/local-runner.ts`) can be invoked either way.
 */
import { spawn } from 'node:child_process';
import {
  type RegionTopology,
  type TimelineSummary,
  evaluateWarmTurnBudget,
  parseServerTimingTurnMarks,
  resolveWarmTurnBudget,
} from '../src/core/latency-budget';
import { computeStats, formatMs, type Stats } from '../src/core/latency-stats';
import {
  findNewAssistantMessage,
  knownMessageIds,
  messageGenerationMs,
  type OcMessage,
} from '../src/core/latency-turn';

// ─── Config ─────────────────────────────────────────────────────────────────

interface Config {
  apiBase: string; // normalized, ends in /v1, no trailing slash beyond that
  token: string;
  sandboxId: string;
  ocSessionId: string | null;
  iterations: number;
  prompt: string;
  pollIntervalMs: number;
  pollTimeoutMs: number;
}

function flagValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function normalizeApiBase(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`--target must be an absolute URL, got: ${raw}`);
  }
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    throw new Error(`--target must use https (got ${url.protocol}) unless it is loopback`);
  }
  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = path.endsWith('/v1') ? path : `${path}/v1`;
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

function resolveConfig(argv: string[], env: NodeJS.ProcessEnv): Config {
  const targetRaw = flagValue(argv, '--target') ?? env.KE2E_LATENCY_TARGET;
  if (!targetRaw) {
    throw new Error('--target <origin> (or KE2E_LATENCY_TARGET) is required');
  }
  const token = flagValue(argv, '--token') ?? env.KE2E_LATENCY_TOKEN;
  if (!token) {
    throw new Error('--token <bearer> (or KE2E_LATENCY_TOKEN) is required');
  }
  const sandboxId = flagValue(argv, '--sandbox-id') ?? env.KE2E_LATENCY_SANDBOX_ID;
  if (!sandboxId) {
    throw new Error(
      '--sandbox-id <id> (or KE2E_LATENCY_SANDBOX_ID) is required — the Kortix session id, ' +
        'which IS the sandbox external id. This tool measures an EXISTING warm session; see ' +
        'this file\'s header comment for how to create one with the real CLI.',
    );
  }
  const iterations = Number(flagValue(argv, '--iterations') ?? env.KE2E_LATENCY_ITERATIONS ?? '5');
  if (!Number.isInteger(iterations) || iterations < 1) {
    throw new Error('--iterations must be a positive integer');
  }
  return {
    apiBase: normalizeApiBase(targetRaw),
    token,
    sandboxId,
    ocSessionId: flagValue(argv, '--oc-session-id') ?? env.KE2E_LATENCY_OC_SESSION_ID ?? null,
    iterations,
    prompt: flagValue(argv, '--prompt') ?? env.KE2E_LATENCY_PROMPT ?? 'Reply with exactly: OK',
    pollIntervalMs: Number(env.KE2E_LATENCY_POLL_INTERVAL_MS ?? '75'),
    pollTimeoutMs: Number(env.KE2E_LATENCY_POLL_TIMEOUT_MS ?? '60000'),
  };
}

// ─── HTTP helpers ───────────────────────────────────────────────────────────

function sandboxPath(cfg: Config, suffix: string): string {
  return `${cfg.apiBase}/p/${cfg.sandboxId}/8000${suffix.startsWith('/') ? suffix : `/${suffix}`}`;
}

function authHeaders(cfg: Config): Record<string, string> {
  return { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' };
}

interface HealthResponse {
  status?: string;
  environment?: string;
  commit?: string;
  region?: string | null;
  database_region?: string | null;
}

async function fetchHealth(cfg: Config): Promise<HealthResponse> {
  const res = await fetch(`${cfg.apiBase}/health`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`${cfg.apiBase}/health returned ${res.status}`);
  return (await res.json()) as HealthResponse;
}

async function ensureOcSession(cfg: Config): Promise<string> {
  if (cfg.ocSessionId) return cfg.ocSessionId;
  const res = await fetch(sandboxPath(cfg, '/session?directory=%2Fworkspace'), {
    method: 'POST',
    headers: authHeaders(cfg),
    body: '{}',
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(`could not create an OpenCode conversation: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { id?: string };
  if (!body.id) throw new Error(`OpenCode session create returned no id: ${JSON.stringify(body)}`);
  return body.id;
}

async function listOcMessages(cfg: Config, ocSessionId: string): Promise<OcMessage[]> {
  const res = await fetch(sandboxPath(cfg, `/session/${ocSessionId}/message`), {
    headers: authHeaders(cfg),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`message list returned ${res.status}: ${await res.text()}`);
  const body = await res.json();
  return Array.isArray(body) ? (body as OcMessage[]) : [];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── One-shot DNS/TCP/TLS overhead (curl -w), separate from iteration timing ─

interface NetworkOverhead {
  dnsMs: number;
  connectMs: number;
  tlsMs: number;
  ttfbMs: number;
  totalMs: number;
}

/**
 * A fresh connection's DNS+TCP+TLS setup, measured ONCE via `curl -w`, kept
 * separate from the iteration loop below (which reuses one warmed connection
 * — see `runIterations`). Without this split, the FIRST measured request
 * silently inflates every stat with a one-time cost that has nothing to do
 * with the send path — exactly what the task brief's own prior run got wrong.
 * Returns null when `curl` is unavailable rather than failing the benchmark.
 */
async function measureNetworkOverhead(url: string): Promise<NetworkOverhead | null> {
  const format = '%{time_namelookup} %{time_connect} %{time_appconnect} %{time_starttransfer} %{time_total}';
  try {
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn('curl', ['-s', '-o', '/dev/null', '-w', format, url]);
      let out = '';
      child.stdout.on('data', (d) => (out += d.toString()));
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`curl exited ${code}`))));
    });
    const [dns, connect, appconnect, starttransfer, total] = output.trim().split(/\s+/).map(Number);
    if ([dns, connect, appconnect, starttransfer, total].some((v) => !Number.isFinite(v))) return null;
    return {
      dnsMs: Math.round(dns! * 1000),
      connectMs: Math.round((connect! - dns!) * 1000),
      tlsMs: Math.round((appconnect! - connect!) * 1000),
      ttfbMs: Math.round((starttransfer! - appconnect!) * 1000),
      totalMs: Math.round(total! * 1000),
    };
  } catch {
    return null;
  }
}

// ─── One iteration ──────────────────────────────────────────────────────────

interface IterationResult {
  sendToDeliveredMs: number;
  deliveredToModelStartMs: number;
  modelGenerationMs: number | null;
  completionToReturnMs: number | null;
  timeline: TimelineSummary | null;
}

async function runIteration(cfg: Config, ocSessionId: string): Promise<IterationResult> {
  const before = await listOcMessages(cfg, ocSessionId);
  const known = knownMessageIds(before);

  const t0 = performance.now();
  const sendRes = await fetch(sandboxPath(cfg, `/session/${ocSessionId}/prompt_async`), {
    method: 'POST',
    headers: authHeaders(cfg),
    body: JSON.stringify({ parts: [{ type: 'text', text: cfg.prompt }] }),
    signal: AbortSignal.timeout(30_000),
  });
  const t1 = performance.now();
  if (!sendRes.ok) {
    throw new Error(`prompt_async returned ${sendRes.status}: ${await sendRes.text()}`);
  }
  const timeline = parseServerTimingTurnMarks(sendRes.headers.get('server-timing'));

  const deadline = Date.now() + cfg.pollTimeoutMs;
  let modelStartAt: number | null = null;
  let assistant: OcMessage | null = null;
  let completedPollDurationMs: number | null = null;

  while (Date.now() < deadline) {
    const pollStart = performance.now();
    const messages = await listOcMessages(cfg, ocSessionId);
    const pollEnd = performance.now();
    const found = findNewAssistantMessage(messages, known);
    if (found) {
      if (modelStartAt === null) modelStartAt = pollEnd;
      assistant = found;
      if (messageGenerationMs(found) !== null) {
        completedPollDurationMs = pollEnd - pollStart;
        break;
      }
    }
    await sleep(cfg.pollIntervalMs);
  }

  if (!assistant || modelStartAt === null) {
    throw new Error(
      `no new assistant message observed within ${cfg.pollTimeoutMs}ms of sending the prompt`,
    );
  }
  const generationMs = messageGenerationMs(assistant);
  if (generationMs === null || completedPollDurationMs === null) {
    throw new Error(
      `assistant message ${assistant.info?.id ?? '(no id)'} never reached a completed state ` +
        `within ${cfg.pollTimeoutMs}ms`,
    );
  }

  return {
    sendToDeliveredMs: t1 - t0,
    deliveredToModelStartMs: modelStartAt - t1,
    modelGenerationMs: generationMs,
    completionToReturnMs: completedPollDurationMs,
    timeline,
  };
}

// ─── Report ─────────────────────────────────────────────────────────────────

function printStatsRow(name: string, values: number[]): Stats {
  const stats = computeStats(values);
  console.log(
    `  ${name.padEnd(24)} median=${formatMs(stats.median).padStart(8)}  ` +
      `min=${formatMs(stats.min).padStart(8)}  max=${formatMs(stats.max).padStart(8)}  ` +
      `spread=${stats.spread === Infinity ? 'inf' : `${stats.spread.toFixed(2)}x`}`,
  );
  return stats;
}

async function main(): Promise<number> {
  const cfg = resolveConfig(process.argv.slice(2), process.env);
  console.log(`[latency] target=${cfg.apiBase} sandbox=${cfg.sandboxId} iterations=${cfg.iterations}`);

  const health = await fetchHealth(cfg);
  const topology: RegionTopology = {
    apiRegion: health.region ?? null,
    databaseRegion: health.database_region ?? null,
  };
  const resolved = resolveWarmTurnBudget(topology);
  console.log(
    `[latency] deployment commit=${health.commit ?? 'unknown'} environment=${health.environment ?? 'unknown'} ` +
      `api_region=${topology.apiRegion ?? 'unknown'} database_region=${topology.databaseRegion ?? 'unknown'}`,
  );
  console.log(
    resolved.colocated === true
      ? `[latency] topology: COLOCATED — applying the strict §2 budget ` +
          `(preflight<=${resolved.budget.preflightMs}ms, delivery<=${resolved.budget.deliveryMs}ms, total<=${resolved.budget.totalMs}ms)`
      : resolved.colocated === false
        ? `[latency] topology: SPLIT (${topology.apiRegion} != ${topology.databaseRegion}) — ` +
            `§2's 150ms bar assumes colocation; applying a loose sanity bound instead ` +
            `(preflight<=${resolved.budget.preflightMs}ms, delivery<=${resolved.budget.deliveryMs}ms, total<=${resolved.budget.totalMs}ms). ` +
            `This is a hang guard, NOT a performance verdict — only a colocated target proves §2.`
        : `[latency] topology: UNKNOWN (region unavailable from /health) — defaulting to the strict ` +
            `§2 budget rather than silently relaxing it`,
  );

  const overhead = await measureNetworkOverhead(`${cfg.apiBase}/health`);
  if (overhead) {
    console.log(
      `[latency] one-shot network overhead (fresh connection, NOT part of iteration timings): ` +
        `dns=${overhead.dnsMs}ms connect=${overhead.connectMs}ms tls=${overhead.tlsMs}ms ` +
        `ttfb=${overhead.ttfbMs}ms total=${overhead.totalMs}ms`,
    );
  } else {
    console.log('[latency] one-shot network overhead: unavailable (curl not usable here)');
  }

  const ocSessionId = await ensureOcSession(cfg);
  console.log(`[latency] opencode session=${ocSessionId}${cfg.ocSessionId ? ' (reused)' : ' (created)'}`);

  // Warm the connection (and the runtime) before any measured iteration —
  // Bun/undici pool keep-alive connections per origin, so this pays the DNS
  // +TCP+TLS cost exactly once, outside every number reported below.
  await fetchHealth(cfg);

  const results: IterationResult[] = [];
  const budgetFailures: string[] = [];
  for (let i = 1; i <= cfg.iterations; i++) {
    const r = await runIteration(cfg, ocSessionId);
    results.push(r);
    const totalMs = r.sendToDeliveredMs + r.deliveredToModelStartMs + (r.modelGenerationMs ?? 0) + (r.completionToReturnMs ?? 0);
    console.log(
      `[latency] run ${i}/${cfg.iterations}: send->delivered=${formatMs(r.sendToDeliveredMs)} ` +
        `delivered->model-start=${formatMs(r.deliveredToModelStartMs)} ` +
        `generation=${formatMs(r.modelGenerationMs ?? 0)} completion->return=${formatMs(r.completionToReturnMs ?? 0)} ` +
        `total=${formatMs(totalMs)}`,
    );
    if (r.timeline) {
      const verdict = evaluateWarmTurnBudget(r.timeline, resolved.budget);
      const parts = r.timeline.marks.map((m) => `${m.label}=${m.deltaMs}ms`).join(' ');
      console.log(`[latency]   pre-flight breakdown: ${parts} (total=${r.timeline.totalMs}ms)`);
      if (!verdict.pass) {
        for (const v of verdict.violations) {
          const line =
            `run ${i}: ${v.category} budget blown by "${v.stage}" — ` +
            `${v.actualMs}ms > ${v.budgetMs}ms (over by ${v.overByMs}ms)`;
          console.log(`[latency]   FAIL ${line}`);
          budgetFailures.push(line);
        }
      }
    } else {
      console.log(
        '[latency]   pre-flight breakdown: UNAVAILABLE — this API build has not shipped ' +
          '`Server-Timing: turnstage-*` yet, so §2 could not be assessed for this run',
      );
    }
  }

  console.log(`\n[latency] ${cfg.iterations} iterations — median and spread (max/min):`);
  printStatsRow('send -> delivered', results.map((r) => r.sendToDeliveredMs));
  printStatsRow('delivered -> model start', results.map((r) => r.deliveredToModelStartMs));
  printStatsRow('model generation', results.map((r) => r.modelGenerationMs ?? 0));
  printStatsRow('completion -> return', results.map((r) => r.completionToReturnMs ?? 0));
  printStatsRow(
    'total',
    results.map(
      (r) => r.sendToDeliveredMs + r.deliveredToModelStartMs + (r.modelGenerationMs ?? 0) + (r.completionToReturnMs ?? 0),
    ),
  );

  const assessedCount = results.filter((r) => r.timeline).length;
  if (assessedCount === 0) {
    console.log(
      '\n[latency] WARNING: §2 was not assessed on any iteration — no run returned a ' +
        '`Server-Timing: turnstage-*` breakdown. The client-side timings above are still real, ' +
        'but the budget is unverified against this deployment.',
    );
    return 0;
  }
  if (budgetFailures.length > 0) {
    console.log(`\n[latency] FAIL — §2 budget exceeded on ${budgetFailures.length} stage(s):`);
    for (const f of budgetFailures) console.log(`  - ${f}`);
    return 1;
  }
  console.log(`\n[latency] PASS — §2 budget held on all ${assessedCount} assessed iteration(s).`);
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(`[latency] FAIL: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
