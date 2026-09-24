/**
 * pi harness end-to-end against a running local stack.
 *
 *   bun pi-e2e.ts setup  --api http://localhost:14208/v1 --runtime pi|opencode --name <n>
 *   bun pi-e2e.ts run    --api ... --project <id> --provider daytona [--agent <name>] [--prompt "..."] [--keep]
 *   bun pi-e2e.ts cr     --api ... --project <id> --head <branch> [--title "..."]   (open + merge a change request)
 *
 * setup: provisions a managed project (starter template), clones it through
 * the Git proxy with a PAT, sets `runtime:` in kortix.yaml, pushes.
 * run: creates a session, polls /start + /kortix/health to runtimeReady,
 * records the in-guest boot timeline and the daemon's `harness`, sends one
 * prompt through the API inbox, waits for the turn to end, reads the
 * transcript back through the daemon and prints everything as JSON.
 */
import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}
function need(name: string): string {
  const v = arg(name);
  if (!v) throw new Error(`--${name} is required`);
  return v;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const SB = (process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321').replace(/\/+$/, '');
const SB_JWT_SECRET = process.env.SUPABASE_JWT_SECRET ?? 'super-secret-jwt-token-with-at-least-32-characters-long';
const DB_URL = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

async function api<T = any>(base: string, token: string, path: string, init: RequestInit = {}): Promise<{ status: number; body: T; headers: Headers }> {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', 'accept-encoding': 'identity', authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let body: any = text;
  try {
    body = JSON.parse(text);
  } catch {}
  return { status: res.status, body, headers: res.headers };
}

function psql(sqlText: string): string {
  return execFileSync('psql', [DB_URL, '-At', '-c', sqlText], { encoding: 'utf8' }).trim();
}

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

async function jwt(): Promise<string> {
  const email = arg('email', 'pi-e2e@kortix.test')!;
  const token = await mintJwt(email);
  const base = need('api');
  const accounts = await api(base, token, '/accounts');
  if (accounts.status !== 200) throw new Error(`accounts ${accounts.status}: ${JSON.stringify(accounts.body).slice(0, 200)}`);
  return token;
}

const AGENT_MD = `---
description: E2E agent
mode: primary
---
You are the Kortix E2E agent. When asked, use the bash tool to run the exact command the user gives and report its output verbatim in one short sentence.
`;

async function setup(): Promise<void> {
  const base = need('api');
  const runtime = arg('runtime', 'pi')!;
  const name = arg('name', `pi-e2e-${runtime}-${Date.now().toString(36)}`)!;
  const token = await jwt();
  const provisioned = await api(base, token, '/projects/provision', { method: 'POST', body: JSON.stringify({ name, seed_starter: true }) });
  if (provisioned.status !== 201) throw new Error(`provision failed ${provisioned.status}: ${JSON.stringify(provisioned.body).slice(0, 300)}`);
  const projectId: string = provisioned.body.project_id ?? provisioned.body.id ?? provisioned.body.project?.project_id;
  const project = await api(base, token, `/projects/${projectId}`);
  const originUrl: string = project.body.git_origin_url;
  const pat = await api(base, token, '/accounts/tokens', { method: 'POST', body: JSON.stringify({ name: `pi-e2e-${name}` }) });
  if (pat.status !== 201) throw new Error(`pat mint failed ${pat.status}: ${JSON.stringify(pat.body).slice(0, 300)}`);
  const secret: string = pat.body.secret_key;
  const work = join(mkdtempSync(join(tmpdir(), 'pi-e2e-')), name);
  const authed = originUrl.replace('://', `://x-access-token:${encodeURIComponent(secret)}@`);
  const g = (...a: string[]) => execFileSync('git', a, { cwd: work, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).trim();
  execFileSync('git', ['clone', '-q', authed, work], { encoding: 'utf8' });
  const manifestPath = join(work, 'kortix.yaml');
  let manifest = readFileSync(manifestPath, 'utf8');
  manifest = manifest.replace(/^runtime:.*\n/m, '');
  if (runtime === 'pi') manifest = manifest.replace(/^kortix_version:\s*2\s*\n/m, (m) => `${m}runtime: pi\n`);
  writeFileSync(manifestPath, manifest);
  const agentsDir = join(work, '.kortix', 'opencode', 'agents');
  execFileSync('mkdir', ['-p', agentsDir]);
  const defaultAgent = /^default_agent:\s*(\S+)/m.exec(manifest)?.[1] ?? 'build';
  writeFileSync(join(agentsDir, `${defaultAgent}.md`), AGENT_MD);
  g('add', '-A');
  g('-c', 'user.name=pi-e2e', '-c', 'user.email=pi-e2e@kortix.test', 'commit', '-q', '-m', `e2e: runtime ${runtime}`);
  g('push', '-q', 'origin', 'HEAD:main');
  const sha = g('rev-parse', 'HEAD');
  console.log(JSON.stringify({ project_id: projectId, name, runtime, default_agent: defaultAgent, sha, manifest_head: manifest.split('\n').slice(0, 4) }));
}

/** Open a change request for `--head` (a branch already in the project repo) and merge it. */
async function changeRequest(): Promise<void> {
  const base = need('api');
  const projectId = need('project');
  const head = need('head');
  const token = await jwt();
  const created = await api(base, token, `/projects/${projectId}/change-requests`, {
    method: 'POST',
    body: JSON.stringify({ title: arg('title', `pi-e2e ${head}`), head_ref: head }),
  });
  const crId: string | undefined = created.body?.cr_id ?? created.body?.id;
  const out: Record<string, unknown> = { head, create_status: created.status, cr_id: crId ?? null };
  if (created.status === 201 && crId) {
    const merged = await api(base, token, `/projects/${projectId}/change-requests/${crId}/merge`, { method: 'POST', body: '{}' });
    out.merge_status = merged.status;
    out.merge_body = typeof merged.body === 'string' ? merged.body.slice(0, 600) : JSON.stringify(merged.body).slice(0, 600);
  } else {
    out.create_body = JSON.stringify(created.body).slice(0, 600);
  }
  console.log(JSON.stringify(out, null, 2));
}

/** Register a project straight in the DB (the flows' database-project fixture), pointing at a local repo. */
async function setupDb(): Promise<void> {
  const base = need('api');
  const repoUrl = need('repo');
  const name = arg('name', `pi-e2e-${Date.now().toString(36)}`)!;
  const token = await jwt();
  const payload = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as { sub: string };
  const userId = payload.sub;
  const accounts = await api(base, token, '/accounts');
  const list: any[] = Array.isArray(accounts.body) ? accounts.body : accounts.body?.accounts ?? accounts.body?.data ?? [];
  const personal = list.find((a) => a.account_id === userId || a.id === userId || a.type === 'personal') ?? list[0];
  const accountId: string = personal?.account_id ?? personal?.id ?? userId;
  const projectId = crypto.randomUUID();
  const metadata = JSON.stringify({ experimental: { apps: false }, onboarding_completed_at: '2026-01-01T00:00:00.000Z' });
  psql(
    `WITH p AS (INSERT INTO kortix.projects (project_id, account_id, name, repo_url, default_branch, manifest_path, status, metadata)
       VALUES ('${projectId}'::uuid, '${accountId}'::uuid, '${name}', '${repoUrl}', 'main', 'kortix.yaml', 'active'::kortix.project_status, '${metadata}'::jsonb) RETURNING project_id)
     INSERT INTO kortix.project_members (account_id, project_id, user_id, project_role, granted_by)
       SELECT '${accountId}'::uuid, project_id, '${userId}'::uuid, 'manager'::kortix.project_role, '${userId}'::uuid FROM p`,
  );
  const project = await api(base, token, `/projects/${projectId}`);
  console.log(JSON.stringify({ project_id: projectId, name, repo_url: repoUrl, account_id: accountId, get_status: project.status, git_origin_url: project.body?.git_origin_url ?? null }));
}

function mintMessageId(): string {
  const time = (BigInt(Date.now()) * BigInt(0x1000)) & BigInt(0xffffffffffff);
  const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  let tail = '';
  for (let i = 0; i < 14; i++) tail += B62[Math.floor(Math.random() * 62)];
  return `msg_${time.toString(16).padStart(12, '0')}${tail}`;
}

async function run(): Promise<void> {
  const base = need('api');
  const projectId = need('project');
  const provider = arg('provider', 'daytona');
  const prompt = arg('prompt', 'Run `echo pi-e2e-$((6*7))` with bash and tell me the output.')!;
  const keep = process.argv.includes('--keep');
  const timeoutMs = Number(arg('timeout-s', '420')) * 1000;
  const token = await jwt();
  const t0 = performance.now();
  const at = () => Math.round(performance.now() - t0);
  const out: Record<string, unknown> = { project_id: projectId, provider };
  const agent = arg('agent');
  const created = await api(base, token, `/projects/${projectId}/sessions`, { method: 'POST', body: JSON.stringify({ provider, ...(agent ? { agent_name: agent } : {}) }) });
  if (created.status !== 201) throw new Error(`create ${created.status}: ${JSON.stringify(created.body).slice(0, 300)}`);
  const sessionId: string = created.body.session_id ?? created.body.id;
  out.session_id = sessionId;
  out.create_ack_ms = at();
  try {
    let externalId: string | null = null;
    let runtimeUrl: string | null = null;
    const deadline = t0 + timeoutMs;
    while (performance.now() < deadline) {
      const s = await api(base, token, `/projects/${projectId}/sessions/${sessionId}/start`, { method: 'POST' });
      if (s.body?.stage === 'ready') {
        externalId = s.body.sandbox?.external_id ?? null;
        runtimeUrl = s.body.runtime_url ?? null;
        out.start_ready_ms = at();
        out.sandbox_provider = s.body.sandbox?.provider ?? null;
        break;
      }
      if (s.body?.stage === 'failed' && s.body?.retriable === false) throw new Error(`start failed: ${JSON.stringify(s.body.failure ?? s.body).slice(0, 400)}`);
      await sleep(500);
    }
    if (!externalId) throw new Error('start never reached ready');
    out.external_id = externalId;
    const daemon = runtimeUrl ? runtimeUrl.replace(/^\/v1/, '') : `/p/${externalId}/8000`;
    let health: any = null;
    while (performance.now() < deadline) {
      const h = await api(base, token, `${daemon}/kortix/health`);
      if (h.status === 200 && h.body?.runtimeReady === true) {
        health = h.body;
        out.runtime_ready_ms = at();
        break;
      }
      await sleep(250);
    }
    if (!health) throw new Error('runtimeReady never true');
    out.harness = health.harness ?? 'opencode';
    out.health_opencode = health.opencode;
    out.health_model = health.model ?? null;
    out.opencode_session_id = health.opencode_session_id;
    out.boot_timeline = health.boot_timeline;
    out.image = psql(`select coalesce(metadata->'runtimeArtifact'->>'providerArtifactRef','') from kortix.session_sandboxes where sandbox_id='${sessionId}'`);
    out.daemon_has_pi = (await api(base, token, `${daemon}/kortix/opencode/state`)).body?.identity?.harness ?? null;
    out.extensions = health.extensions ?? null;
    out.tool_ids = (await api(base, token, `${daemon}/tool/ids`)).body ?? null;
    // The daemon's own pi lines: runtime ready (ms, extensionsMs), package bundle download.
    const diag = await api(base, token, `${daemon}/kortix/diag?tail=400`);
    out.pi_log = String(diag.body?.logs?.daemon ?? '').split('\n').filter((line) => line.includes('[pi]')).map((line) => line.slice(0, 600));

    // One prompt through the inbox.
    const messageId = mintMessageId();
    const tp = performance.now();
    const queued = await api(base, token, `/projects/${projectId}/sessions/${sessionId}/prompts`, {
      method: 'POST',
      body: JSON.stringify({ client_message_id: `pi-e2e-${Date.now()}`, message_id: messageId, parts: [{ type: 'text', text: prompt }] }),
    });
    out.prompt_status = queued.status;
    if (queued.status !== 202 && queued.status !== 200) throw new Error(`prompt ${queued.status}: ${JSON.stringify(queued.body).slice(0, 300)}`);
    out.message_id = messageId;
    // Wait for the turn to END: the daemon's own transcript, read through the proxy.
    const root = health.opencode_session_id as string;
    let reply: any = null;
    let ledgerEnded = false;
    let firstAssistantMs: number | null = null;
    while (performance.now() < deadline) {
      const page = await api(base, token, `${daemon}/kortix/opencode/messages/${encodeURIComponent(root)}?limit=50`);
      const messages: any[] = page.body?.messages ?? [];
      const user = messages.find((m) => m.info?.id === messageId);
      const assistants = messages.filter((m) => m.info?.role === 'assistant' && m.info?.parentID === messageId);
      if (assistants.length && firstAssistantMs === null) firstAssistantMs = Math.round(performance.now() - tp);
      const done = assistants.find((m) => m.info?.time?.completed && m.parts?.some((p: any) => p.type === 'text' && p.text?.trim()));
      const collect = (from: any) => ({ text: from.parts.filter((p: any) => p.type === 'text').map((p: any) => p.text).join(''), tools: assistants.flatMap((m) => m.parts.filter((p: any) => p.type === 'tool').map((p: any) => ({ tool: p.tool, status: p.state?.status, output: String(p.state?.output ?? '').slice(0, 120) }))) });
      if (user && done) {
        reply = collect(done);
        break;
      }
      // Harness-neutral stop: the API's turn ledger says the turn ended. OpenCode's
      // transcript read does not always satisfy the `done` shape above, so the
      // ledger is the authority for "the turn is over"; the reply is best effort.
      const ledgerState = psql(`select state from kortix.session_turns where session_id='${sessionId}' order by created_at desc limit 1`);
      if (ledgerState === 'ended') {
        ledgerEnded = true;
        const last = assistants[assistants.length - 1];
        if (last) reply = collect(last);
        break;
      }
      await sleep(500);
    }
    out.turn_ms = Math.round(performance.now() - tp);
    out.first_assistant_ms = firstAssistantMs;
    out.reply = reply;
    out.turn_ledger = psql(`select state||'/'||coalesce(end_reason,'') from kortix.session_turns where session_id='${sessionId}' order by created_at desc limit 1`);
    // Turn duration as the control plane saw it: ledger row created → ended.
    out.ledger_turn_ms = Number(psql(`select round(extract(epoch from (ended_at - created_at))*1000) from kortix.session_turns where session_id='${sessionId}' and ended_at is not null order by created_at desc limit 1`)) || null;
    // The API's own read of the transcript (server mirror) for the same session.
    const apiTurn = await api(base, token, `/projects/${projectId}/sessions/${sessionId}/turn`);
    out.api_turn_status = apiTurn.status;
    if (!reply && !ledgerEnded) throw new Error('no completed assistant reply before deadline');
  } catch (err) {
    out.error = err instanceof Error ? err.message : String(err);
  } finally {
    if (!keep) await api(base, token, `/projects/${projectId}/sessions/${sessionId}`, { method: 'DELETE' }).catch(() => {});
  }
  console.log(JSON.stringify(out, null, 2));
  if (out.error) process.exit(1);
}

async function status(): Promise<void> {
  const base = need('api');
  const projectId = need('project');
  const sessionId = need('session');
  const token = await jwt();
  const s = await api(base, token, `/projects/${projectId}/sessions/${sessionId}/start`, { method: 'POST' });
  console.log(JSON.stringify({ status: s.status, body: s.body }, null, 2).slice(0, 4000));
  const eid = arg('external');
  if (eid) {
    const h = await api(base, token, `/p/${eid}/8000/kortix/health`);
    console.log(JSON.stringify({ health_status: h.status, health: h.body }, null, 2).slice(0, 4000));
    const logs = await api(base, token, `/p/${eid}/8000/kortix/logs?tail=80`);
    console.log(String(typeof logs.body === 'string' ? logs.body : JSON.stringify(logs.body)).slice(-6000));
  }
}

async function probe(): Promise<void> {
  const base = need('api');
  const eid = need('external');
  const root = arg('root');
  const token = await jwt();
  const show = async (path: string, max = 1500) => {
    const r = await api(base, token, path);
    const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
    console.log(`\n=== ${path} -> ${r.status}\n${text.slice(0, max)}`);
  };
  await show(`/p/${eid}/8000/kortix/health`, 900);
  await show(`/p/${eid}/8000/kortix/opencode/state`, 1800);
  if (root) await show(`/p/${eid}/8000/kortix/opencode/messages/${encodeURIComponent(root)}?limit=50`, 4000);
  await show(`/p/${eid}/8000/session`, 600);
  await show(`/p/${eid}/8000/kortix/logs?tail=${arg('tail', '120')}`, 9000);
}

/** Set or clear a per-project feature flag override (PATCH /projects/:id/features). */
async function flag(): Promise<void> {
  const base = need('api');
  const projectId = need('project');
  const feature = need('feature');
  const raw = need('enabled');
  const enabled = raw === 'null' ? null : raw === 'true';
  const token = await jwt();
  const r = await api(base, token, `/projects/${projectId}/features`, { method: 'PATCH', body: JSON.stringify({ feature, enabled }) });
  const flags = (r.body?.experimental ?? r.body?.feature_flags ?? null) as Record<string, boolean> | null;
  console.log(JSON.stringify({ status: r.status, feature, enabled, effective: flags?.[feature] ?? null }));
}

async function del(): Promise<void> {
  const base = need('api');
  const projectId = need('project');
  const token = await jwt();
  for (const sessionId of need('sessions').split(',')) {
    const r = await api(base, token, `/projects/${projectId}/sessions/${sessionId.trim()}`, { method: 'DELETE' });
    console.log(sessionId.trim(), r.status);
  }
}

switch (process.argv[2]) {
  case 'delete':
    await del();
    break;
  case 'flag':
    await flag();
    break;
  case 'probe':
    await probe();
    break;
  case 'status':
    await status();
    break;
  case 'setup':
    await setup();
    break;
  case 'setup-db':
    await setupDb();
    break;
  case 'run':
    await run();
    break;
  case 'cr':
    await changeRequest();
    break;
  default:
    console.error('usage: pi-e2e.ts setup|setup-db|run|cr|status|probe|flag|delete …');
    process.exit(2);
}
