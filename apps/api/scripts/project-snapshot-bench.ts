#!/usr/bin/env bun
/**
 * Real-boot smoke + benchmark for the S3 config provider, through the REAL
 * session-create path (HTTP API → provider sandbox → kortixd → runtimeReady).
 *
 * Nothing here talks to a sandbox directly except through the API's proxy, and
 * nothing is mocked: the arms differ only by which API answers (baseline main
 * vs this branch) and by the project's `project_snapshot_mode` metadata.
 *
 *   bun run scripts/project-snapshot-bench.ts jwt   --email localdev@kortix.test
 *   bun run scripts/project-snapshot-bench.ts setup --api http://localhost:13608/v1 --jwt <jwt> \
 *        --name bench-repr --files 400 --file-bytes 4096            # provision + push fixture
 *   bun run scripts/project-snapshot-bench.ts wait  --api … --pat <pat> --project <id> --sha <sha>
 *   bun run scripts/project-snapshot-bench.ts run   --jwt <jwt> --project <id> --rounds 30 \
 *        --arms "baseline-git=http://localhost:8008/v1|baseline,new-git=http://localhost:13608/v1|git,new-s3=http://localhost:13608/v1|prefer-s3" \
 *        --out /tmp/bench.jsonl [--api-log <path>=<label> …]
 *   bun run scripts/project-snapshot-bench.ts report --in /tmp/bench.jsonl
 *
 * Every round: set the arm's mode on the project (SQL, shared DB), POST a
 * session, poll /start to `ready`, poll the box's /kortix/health through the
 * proxy to `runtimeReady`, record the daemon's `config_provider`, boot
 * timeline, commit, sandbox provider, and count Git-proxy requests in the
 * arm's API log inside the boot window. Arms alternate round by round.
 */
import { createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SB = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321';
const SB_JWT_SECRET = process.env.SUPABASE_JWT_SECRET ?? 'super-secret-jwt-token-with-at-least-32-characters-long';
const DB_URL = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}
function need(name: string): string {
  const v = arg(name);
  if (!v) {
    console.error(`--${name} is required`);
    process.exit(2);
  }
  return v;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function api<T = any>(base: string, token: string, path: string, init: RequestInit = {}): Promise<{ status: number; body: T; ms: number }> {
  const t0 = performance.now();
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let body: any = text;
  try {
    body = JSON.parse(text);
  } catch {}
  return { status: res.status, body, ms: performance.now() - t0 };
}

function psql(sqlText: string): string {
  return execFileSync('psql', [DB_URL, '-At', '-c', sqlText], { encoding: 'utf8' }).trim();
}

// ── jwt ─────────────────────────────────────────────────────────────────────
async function mintJwt(email: string): Promise<string> {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64({ iss: 'supabase-demo', role: 'service_role', iat: now, exp: now + 600 });
  const admin = `${head}.${body}.${createHmac('sha256', SB_JWT_SECRET).update(`${head}.${body}`).digest('base64url')}`;
  const gl: any = await (
    await fetch(`${SB}/auth/v1/admin/generate_link`, {
      method: 'POST',
      headers: { apikey: admin, Authorization: `Bearer ${admin}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'magiclink', email }),
    })
  ).json();
  if (!gl?.email_otp) throw new Error(`generate_link failed: ${JSON.stringify(gl).slice(0, 200)}`);
  const vr: any = await (
    await fetch(`${SB}/auth/v1/verify`, {
      method: 'POST',
      headers: { apikey: admin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'magiclink', email, token: gl.email_otp }),
    })
  ).json();
  if (!vr?.access_token) throw new Error(`verify failed: ${JSON.stringify(vr).slice(0, 200)}`);
  return vr.access_token;
}

// ── setup: provision + push a fixture through the Git proxy ────────────────
async function setup(): Promise<void> {
  const base = need('api');
  const jwt = need('jwt');
  const name = arg('name', `bench-${Date.now().toString(36)}`)!;
  const files = Number(arg('files', '0'));
  const fileBytes = Number(arg('file-bytes', '2048'));
  const provisioned = await api(base, jwt, '/projects/provision', { method: 'POST', body: JSON.stringify({ name, seed_starter: true }) });
  if (provisioned.status !== 201) throw new Error(`provision failed ${provisioned.status}: ${JSON.stringify(provisioned.body).slice(0, 300)}`);
  const projectId: string = provisioned.body.project_id ?? provisioned.body.id ?? provisioned.body.project?.project_id;
  const project = await api(base, jwt, `/projects/${projectId}`);
  const originUrl: string = project.body.git_origin_url;
  const pat = await api(base, jwt, '/accounts/tokens', { method: 'POST', body: JSON.stringify({ name: `bench-${name}` }) });
  if (pat.status !== 201) throw new Error(`pat mint failed ${pat.status}: ${JSON.stringify(pat.body).slice(0, 300)}`);
  const secret: string = pat.body.secret_key;
  const work = join(tmpdir(), `kortix-bench-${name}`);
  const authed = originUrl.replace('://', `://x-access-token:${encodeURIComponent(secret)}@`);
  const git = (...a: string[]) => execFileSync('git', a, { cwd: existsSync(work) ? work : undefined, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).trim();
  execFileSync('git', ['clone', '-q', authed, work], { encoding: 'utf8' });
  if (files > 0) {
    mkdirSync(join(work, 'fixture'), { recursive: true });
    for (let i = 0; i < files; i += 1) {
      const dir = join(work, 'fixture', `d${Math.floor(i / 100)}`);
      mkdirSync(dir, { recursive: true });
      // Distinct, poorly-compressible content so the archive size is honest.
      writeFileSync(join(dir, `f${i}.txt`), `${i}:${Buffer.from(crypto.getRandomValues(new Uint8Array(Math.ceil(fileBytes * 0.75)))).toString('base64')}\n`);
    }
    git('add', '-A');
    git('-c', 'user.name=bench', '-c', 'user.email=bench@kortix.test', 'commit', '-q', '-m', `bench fixture: ${files} files x ~${fileBytes}B`);
    git('push', '-q', 'origin', 'HEAD:main');
  }
  const sha = git('rev-parse', 'HEAD');
  console.log(JSON.stringify({ project_id: projectId, name, git_origin_url: originUrl, sha, files, pat: secret }));
}

// ── wait: the archive for --sha is ready (descriptor answers 200) ───────────
async function waitReady(): Promise<void> {
  const base = need('api');
  const pat = need('pat');
  const projectId = need('project');
  const sha = need('sha');
  const deadline = Date.now() + Number(arg('timeout-s', '600')) * 1000;
  while (Date.now() < deadline) {
    const r = await api(base, pat, `/git/${projectId}.git/project-snapshot?sha=${sha}`);
    if (r.status === 200) {
      const { url: _url, ...rest } = r.body.archive ?? {};
      console.log(JSON.stringify({ ready: true, sha, archive: rest }));
      return;
    }
    await sleep(2000);
  }
  console.error('archive not ready before timeout');
  process.exit(1);
}

// ── run ─────────────────────────────────────────────────────────────────────
interface Arm {
  label: string;
  api: string;
  mode: 'baseline' | 'git' | 'prefer-s3' | 'require-s3';
}
function parseArms(raw: string): Arm[] {
  return raw.split(',').map((part) => {
    const [label, rest] = part.split('=');
    const [apiUrl, mode] = (rest ?? '').split('|');
    if (!label || !apiUrl || !mode) throw new Error(`bad arm: ${part}`);
    return { label, api: apiUrl, mode: mode as Arm['mode'] };
  });
}

function setProjectMode(projectId: string, mode: Arm['mode']): void {
  if (mode === 'baseline') return;
  psql(`update kortix.projects set metadata = coalesce(metadata,'{}'::jsonb) || jsonb_build_object('project_snapshot_mode','${mode}') where project_id = '${projectId}'`);
}

interface Round {
  round: number;
  arm: string;
  mode: string;
  api: string;
  session_id: string;
  ok: boolean;
  error?: string;
  create_ack_ms: number;
  start_ready_ms: number | null;
  runtime_ready_ms: number | null;
  provider: string | null;
  external_id: string | null;
  commit_sha: string | null;
  config_provider: unknown;
  boot_marks: Record<string, number>;
  session_start_timeline: unknown;
  started_at: string;
  runtime_ready_at: string | null;
  git_proxy_requests: number | null;
  git_proxy_paths: GitProxyRequest[];
}

async function oneRound(arm: Arm, jwt: string, projectId: string, round: number, apiLog?: string): Promise<Round> {
  setProjectMode(projectId, arm.mode);
  const startedAt = new Date();
  const t0 = performance.now();
  const provider = arg('provider');
  const created = await api(arm.api, jwt, `/projects/${projectId}/sessions`, { method: 'POST', body: JSON.stringify(provider ? { provider } : {}) });
  const createAckMs = performance.now() - t0;
  const sessionId: string = created.body?.session_id ?? created.body?.id;
  const result: Round = {
    round,
    arm: arm.label,
    mode: arm.mode,
    api: arm.api,
    session_id: sessionId ?? '',
    ok: false,
    create_ack_ms: Math.round(createAckMs),
    start_ready_ms: null,
    runtime_ready_ms: null,
    provider: null,
    external_id: null,
    commit_sha: null,
    config_provider: null,
    boot_marks: {},
    session_start_timeline: null,
    started_at: startedAt.toISOString(),
    runtime_ready_at: null,
    git_proxy_requests: null,
    git_proxy_paths: [],
  };
  if (created.status !== 201 || !sessionId) {
    result.error = `create ${created.status}: ${JSON.stringify(created.body).slice(0, 200)}`;
    return result;
  }
  try {
    const deadline = t0 + Number(arg('timeout-s', '300')) * 1000;
    let externalId: string | null = null;
    let runtimeUrl: string | null = null;
    while (performance.now() < deadline) {
      const s = await api(arm.api, jwt, `/projects/${projectId}/sessions/${sessionId}/start`, { method: 'POST' });
      if (s.body?.stage === 'ready') {
        externalId = s.body.sandbox?.external_id ?? null;
        runtimeUrl = s.body.runtime_url ?? null;
        result.provider = s.body.sandbox?.provider ?? null;
        result.start_ready_ms = Math.round(performance.now() - t0);
        break;
      }
      if (s.body?.stage === 'failed' && s.body?.retriable === false) throw new Error(`start failed: ${JSON.stringify(s.body.failure ?? s.body).slice(0, 300)}`);
      await sleep(500);
    }
    if (!externalId) throw new Error('start never reached ready');
    result.external_id = externalId;
    const healthPath = runtimeUrl ? `${runtimeUrl.replace(/^\/v1/, '')}/kortix/health` : `/p/${externalId}/8000/kortix/health`;
    while (performance.now() < deadline) {
      const h = await api(arm.api, jwt, healthPath);
      if (h.status === 200 && h.body?.runtimeReady === true) {
        result.runtime_ready_ms = Math.round(performance.now() - t0);
        result.runtime_ready_at = new Date().toISOString();
        result.commit_sha = h.body.commit_sha ?? null;
        result.config_provider = h.body.config_provider ?? null;
        for (const m of h.body.boot_timeline ?? []) result.boot_marks[m.label] = m.atMs;
        break;
      }
      if (h.status === 200 && h.body?.status === 'error') throw new Error(`daemon error: ${h.body.boot_error}`);
      await sleep(500);
    }
    if (result.runtime_ready_ms === null) throw new Error('runtimeReady never observed');
    const row = await api(arm.api, jwt, `/projects/${projectId}/sessions/${sessionId}`);
    result.session_start_timeline = row.body?.metadata?.session_start_timeline ?? null;
    result.ok = true;
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  } finally {
    await api(arm.api, jwt, `/projects/${projectId}/sessions/${sessionId}`, { method: 'DELETE' }).catch(() => {});
  }
  if (apiLog && result.runtime_ready_at) {
    // Window: create → 5 s past observed readiness, so the daemon's own
    // post-ready work (the deferred history backfill fires AT readiness) is
    // visible and attributable by its offset instead of being cut in half by
    // the 500 ms health poll.
    const readyAt = new Date(result.runtime_ready_at);
    const seen = listGitProxyRequests(apiLog, projectId, startedAt, new Date(readyAt.getTime() + 5000), readyAt);
    result.git_proxy_paths = seen;
    // Acquisition-related = anything that completed clearly BEFORE readiness.
    // The descriptor exchange is the S3 path's one expected request.
    result.git_proxy_requests = seen.filter((s) => s.offsetMs < -250).length;
  }
  return result;
}

interface GitProxyRequest {
  method: string;
  path: string;
  status: number;
  /** Completion time relative to the observed runtimeReady (negative = before). */
  offsetMs: number;
}

/**
 * Git-proxy requests for this project logged by the arm's API inside
 * [from, to]. Per PROJECT, not per session: rounds run sequentially with a
 * cooldown, so a window belongs to one boot.
 */
function listGitProxyRequests(logPath: string, projectId: string, from: Date, to: Date, readyAt: Date): GitProxyRequest[] {
  if (!existsSync(logPath)) return [];
  const re = new RegExp(`^\\[(\\d{4}-\\d{2}-\\d{2}T[^\\]]+)\\] \\[INFO\\] Request completed: (GET|POST) /v1/git/${projectId}\\.git/(info/refs|git-upload-pack|fast-boot-bundle|compiled-checkout|project-snapshot) (\\d{3})`);
  const seen: GitProxyRequest[] = [];
  for (const line of readFileSync(logPath, 'utf8').split('\n')) {
    const m = line.match(re);
    if (!m) continue;
    const at = new Date(m[1]!);
    if (at >= from && at <= to) {
      seen.push({ method: m[2]!, path: m[3]!, status: Number(m[4]), offsetMs: at.getTime() - readyAt.getTime() });
    }
  }
  return seen;
}

async function run(): Promise<void> {
  const jwt = need('jwt');
  const projectId = need('project');
  const rounds = Number(arg('rounds', '1'));
  const arms = parseArms(need('arms'));
  const out = arg('out', join(tmpdir(), 'project-snapshot-bench.jsonl'))!;
  const apiLogs = new Map<string, string>();
  for (let i = 0; i < process.argv.length; i += 1) {
    if (process.argv[i] === '--api-log') {
      const [path, label] = (process.argv[i + 1] ?? '').split('=');
      if (path && label) apiLogs.set(label, path);
    }
  }
  const warmups = Number(arg('warmups', '1'));
  for (let w = 0; w < warmups; w += 1) {
    for (const arm of arms) {
      const r = await oneRound(arm, jwt, projectId, -1 - w, apiLogs.get(arm.label));
      console.error(`warmup ${arm.label}: ${r.ok ? `${r.runtime_ready_ms}ms` : `FAILED ${r.error}`}`);
    }
  }
  for (let round = 1; round <= rounds; round += 1) {
    // Alternate arm order every round so drift affects every arm equally.
    const order = round % 2 === 1 ? arms : [...arms].reverse();
    for (const arm of order) {
      const r = await oneRound(arm, jwt, projectId, round, apiLogs.get(arm.label));
      appendFileSync(out, `${JSON.stringify(r)}\n`);
      await sleep(Number(arg('cooldown-ms', '10000')));
      const cp = (r.config_provider ?? {}) as Record<string, unknown>;
      console.error(
        `round ${round} ${arm.label}: ${r.ok ? 'ok' : 'FAIL'} ack=${r.create_ack_ms}ms start=${r.start_ready_ms}ms ready=${r.runtime_ready_ms}ms ` +
          `provider=${cp.provider ?? '?'} fallback=${cp.fallback ?? '?'} reason=${cp.s3_reason ?? '-'} git_proxy=${r.git_proxy_requests ?? '?'}${r.error ? ` ${r.error}` : ''}`,
      );
    }
  }
  console.log(out);
}

// ── report ──────────────────────────────────────────────────────────────────
function pct(sorted: number[], p: number): number {
  if (!sorted.length) return Number.NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}
function report(): void {
  const rows: Round[] = readFileSync(need('in'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const byArm = new Map<string, Round[]>();
  for (const r of rows) byArm.set(r.arm, [...(byArm.get(r.arm) ?? []), r]);
  const table: Record<string, unknown>[] = [];
  for (const [arm, list] of byArm) {
    const ok = list.filter((r) => r.ok);
    const boot = ok.map((r) => r.runtime_ready_ms!).sort((a, b) => a - b);
    const acq = ok
      .map((r) => {
        const cp = r.config_provider as { timings?: Record<string, number> } | null;
        const t = cp?.timings ?? {};
        return (t.warm ?? 0) + (t.git ?? 0) + (t.s3_acquire ?? 0) + (t.s3_activate ?? 0) + (t.s3_failed ?? 0);
      })
      .sort((a, b) => a - b);
    const materialized = ok.map((r) => r.boot_marks['repo-materialized'] ?? Number.NaN).filter(Number.isFinite).sort((a, b) => a - b);
    const s3Attempts = ok.filter((r) => (r.config_provider as any)?.s3_attempted).length;
    const s3Failures = ok.filter((r) => (r.config_provider as any)?.s3_failed).length;
    const fallbacks = ok.filter((r) => (r.config_provider as any)?.fallback).length;
    const providers = ok.reduce<Record<string, number>>((acc, r) => {
      const p = String((r.config_provider as any)?.provider ?? 'n/a');
      acc[p] = (acc[p] ?? 0) + 1;
      return acc;
    }, {});
    table.push({
      arm,
      rounds: list.length,
      ok: ok.length,
      failed: list.length - ok.length,
      providers,
      s3_attempts: s3Attempts,
      s3_failures: s3Failures,
      fallbacks,
      acquisition_p50_ms: pct(acq, 50),
      acquisition_p95_ms: pct(acq, 95),
      repo_materialized_mark_p50_ms: pct(materialized, 50),
      full_boot_p50_ms: pct(boot, 50),
      full_boot_p95_ms: pct(boot, 95),
      full_boot_min_ms: boot[0] ?? null,
      full_boot_max_ms: boot[boot.length - 1] ?? null,
      git_proxy_requests_avg: ok.length ? ok.reduce((a, r) => a + (r.git_proxy_requests ?? 0), 0) / ok.length : null,
      // Which Git-proxy calls completed clearly BEFORE readiness (offset < -250 ms),
      // summed over rounds — the S3 arm should show only `project-snapshot`.
      git_proxy_before_ready_by_path: ok.reduce<Record<string, number>>((acc, r) => {
        for (const q of r.git_proxy_paths ?? []) {
          if (q.offsetMs < -250) acc[`${q.method} ${q.path}`] = (acc[`${q.method} ${q.path}`] ?? 0) + 1;
        }
        return acc;
      }, {}),
      sandbox_providers: ok.reduce<Record<string, number>>((acc, r) => {
        acc[r.provider ?? '?'] = (acc[r.provider ?? '?'] ?? 0) + 1;
        return acc;
      }, {}),
    });
  }
  console.log(JSON.stringify(table, null, 2));
}

switch (process.argv[2]) {
  case 'jwt':
    console.log(await mintJwt(arg('email', 'localdev@kortix.test')!));
    break;
  case 'setup':
    await setup();
    break;
  case 'wait':
    await waitReady();
    break;
  case 'run':
    await run();
    break;
  case 'report':
    report();
    break;
  default:
    console.error('usage: project-snapshot-bench.ts <jwt|setup|wait|run|report> …');
    process.exit(2);
}
process.exit(0);
