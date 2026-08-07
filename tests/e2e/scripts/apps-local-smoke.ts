#!/usr/bin/env -S bun

/**
 * Black-box Kortix Apps smoke for an isolated local-Docker worktree.
 *
 * Required environment:
 *   E2E_API_URL=http://localhost:<api-port>/v1
 *   E2E_SUPABASE_URL=http://127.0.0.1:<supabase-port>
 *   SUPABASE_SERVICE_ROLE_KEY=<isolated stack value>
 *   NEXT_PUBLIC_SUPABASE_ANON_KEY=<isolated stack value>
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import postgres from '../../../packages/db/node_modules/postgres/src/index.js';

const apiBase = process.env.E2E_API_URL ?? 'http://localhost:22308/v1';
const supabaseBase = process.env.E2E_SUPABASE_URL ?? 'http://127.0.0.1:22621';
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const databaseUrl = process.env.E2E_DATABASE_URL;
const repoRoot = resolve(import.meta.dir, '../../..');

if (!serviceRoleKey || !anonKey || !databaseUrl) {
  throw new Error('Supabase credentials and E2E_DATABASE_URL are required');
}

let token = '';
let projectId = '';

function log(message: string, data?: unknown): void {
  process.stdout.write(`[apps-local-smoke] ${message}${data === undefined ? '' : ` ${JSON.stringify(data)}`}\n`);
}

async function request(url: string, init: RequestInit = {}) {
  const response = await fetch(url, init);
  const text = await response.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { response, status: response.status, body, text };
}

async function api(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${token}`);
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  return request(`${apiBase}${path}`, { ...init, headers });
}

async function cli(args: string[]): Promise<any> {
  const proc = Bun.spawn([process.execPath, join(repoRoot, 'apps/cli/src/index.ts'), ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NO_COLOR: '1',
      KORTIX_API_URL: apiBase,
      KORTIX_CLI_TOKEN: token,
      KORTIX_PROJECT_ID: projectId,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`kortix ${args.join(' ')} failed (${exitCode})\nstdout=${stdout}\nstderr=${stderr}`);
  }
  const trimmed = stdout.trim();
  try { return JSON.parse(trimmed); } catch {
    throw new Error(`kortix ${args.join(' ')} returned non-JSON stdout: ${trimmed}\nstderr=${stderr}`);
  }
}

async function publicRequest(url: string, path = '/', init: RequestInit = {}) {
  return request(`${url.replace(/\/$/, '')}${path}`, init);
}

async function waitFor(
  label: string,
  predicate: () => Promise<boolean>,
  timeoutMs = 120_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(500);
  }
  throw new Error(`${label} timed out after ${timeoutMs}ms`);
}

function dynamicServer(marker: string): string {
  return `const marker = ${JSON.stringify(marker)};
const server = Bun.serve({
  port: 3000,
  fetch(request, server) {
    const url = new URL(request.url);
    if (url.pathname === '/ws' && server.upgrade(request)) return;
    if (url.pathname === '/sse') {
      return new Response('event: ready\\ndata: ' + marker + '\\n\\n', {
        headers: { 'content-type': 'text/event-stream' },
      });
    }
    if (url.pathname === '/echo' && request.method === 'POST') {
      return request.text().then((body) => Response.json({ marker, body, method: request.method }));
    }
    return Response.json({
      marker,
      method: request.method,
      cookie: request.headers.get('cookie'),
      plain: process.env.PLAIN_VALUE ?? null,
      secret: process.env.SECRET_VALUE ?? null,
    }, { headers: { 'set-cookie': 'kortix-cookie=present; Path=/; HttpOnly' } });
  },
  websocket: {
    open(ws) { ws.send(marker); },
    message(ws, message) { ws.send('echo:' + message); },
  },
});
console.log('dynamic server listening', server.port, marker);
`;
}

async function assertWebSocket(url: string, expected: string): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const ws = new WebSocket(url.replace(/^http/, 'ws') + '/ws');
    const timer = setTimeout(() => reject(new Error('WebSocket timed out')), 15_000);
    ws.addEventListener('message', (event) => {
      if (String(event.data) !== expected) return;
      clearTimeout(timer);
      ws.close();
      resolvePromise();
    });
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('WebSocket failed'));
    });
  });
}

async function main(): Promise<void> {
  const nonce = Date.now().toString(36);
  const email = `apps-smoke-${nonce}@example.test`;
  const password = `AppsSmoke-${nonce}-A1!`;
  const created = await request(`${supabaseBase}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      apikey: serviceRoleKey!,
      authorization: `Bearer ${serviceRoleKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  if (created.status !== 200) throw new Error(`user create failed: ${created.status} ${created.text}`);

  const grant = await request(`${supabaseBase}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: anonKey!, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  token = grant.body?.access_token ?? '';
  if (!token) throw new Error(`password grant failed: ${grant.status} ${grant.text}`);

  const accounts = await api('/accounts');
  const account = Array.isArray(accounts.body)
    ? accounts.body.find((candidate: any) => candidate.personal_account) ?? accounts.body[0]
    : null;
  if (!account?.account_id) throw new Error(`personal account missing: ${accounts.status} ${accounts.text}`);

  const project = await api('/projects/provision', {
    method: 'POST',
    body: JSON.stringify({
      account_id: account.account_id,
      name: `Apps smoke ${nonce}`,
      seed_starter: true,
    }),
  });
  projectId = project.body?.project_id ?? project.body?.id ?? '';
  if (!projectId) throw new Error(`project provision failed: ${project.status} ${project.text}`);
  log('project created', { project_id: projectId });

  const source = await mkdtemp(join(tmpdir(), 'kortix-apps-static-'));
  const bundleSource = await mkdtemp(join(tmpdir(), 'kortix-apps-bundle-'));
  const dynamicSource = await mkdtemp(join(tmpdir(), 'kortix-apps-dynamic-'));
  const marker = `KORTIX_APPS_STATIC_${nonce}`;
  const sql = postgres(databaseUrl!, { max: 1 });
  try {
    await writeFile(join(source, 'index.html'), `<!doctype html><title>Kortix Apps</title><main>${marker}</main>\n`);
    const deployed = await cli([
      'apps', 'deploy', source,
      '--slug', `static-${nonce}`,
      '--name', 'Static smoke',
      '--type', 'static',
      '--provider', 'local-docker',
      '--wait-seconds', '1200',
      '--json',
    ]);
    if (deployed?.deployment?.status !== 'ready') {
      throw new Error(`static deployment not ready: ${JSON.stringify(deployed)}`);
    }
    log('static deployment ready', {
      app_id: deployed.app.app_id,
      deployment_id: deployed.deployment.deployment_id,
      url: deployed.app.url,
    });

    const publicResponse = await request(deployed.app.url);
    if (publicResponse.status !== 200 || !publicResponse.text.includes(marker)) {
      throw new Error(`public static request failed: ${publicResponse.status} ${publicResponse.text.slice(0, 300)}`);
    }
    log('public static request passed', { status: publicResponse.status, marker });

    const listed = await cli(['apps', 'list', '--json']);
    if (!listed.apps?.some((app: any) => app.app_id === deployed.app.app_id)) {
      throw new Error(`CLI list did not return deployed App: ${JSON.stringify(listed)}`);
    }
    log('CLI list passed', { count: listed.apps.length });

    const bundleMarker = `KORTIX_APPS_BUNDLE_${nonce}`;
    await writeFile(join(bundleSource, 'package.json'), JSON.stringify({
      name: 'kortix-apps-bundle-smoke',
      private: true,
      scripts: { build: 'node build.mjs' },
    }));
    await writeFile(join(bundleSource, 'build.mjs'), `
import { mkdir, writeFile } from 'node:fs/promises';
await mkdir('dist', { recursive: true });
await writeFile('dist/index.html', '<main>${bundleMarker}</main>\\n');
`);
    const bundle = await cli([
      'apps', 'deploy', bundleSource,
      '--slug', `bundle-${nonce}`,
      '--type', 'bundle',
      '--install-command', 'true',
      '--build-command', 'node build.mjs',
      '--provider', 'local-docker',
      '--wait-seconds', '1200',
      '--json',
    ]);
    const bundleResponse = await publicRequest(bundle.app.url);
    if (bundleResponse.status !== 200 || !bundleResponse.text.includes(bundleMarker)) {
      throw new Error(`bundle request failed: ${bundleResponse.status} ${bundleResponse.text}`);
    }
    log('JavaScript bundle deployment passed', { deployment_id: bundle.deployment.deployment_id });

    const secretValue = `secret-${nonce}`;
    const secret = await api(`/projects/${projectId}/secrets`, {
      method: 'POST',
      body: JSON.stringify({ name: 'APP_SMOKE_SECRET', value: secretValue }),
    });
    if (secret.status !== 200 && secret.status !== 201) {
      throw new Error(`project secret create failed: ${secret.status} ${secret.text}`);
    }

    const dynamicMarkerV1 = `KORTIX_APPS_DYNAMIC_V1_${nonce}`;
    await writeFile(join(dynamicSource, 'Dockerfile'), [
      'FROM oven/bun:1.3.14-alpine',
      'WORKDIR /app',
      'COPY server.ts /app/server.ts',
      '',
    ].join('\n'));
    await writeFile(join(dynamicSource, 'server.ts'), dynamicServer(dynamicMarkerV1));
    await writeFile(join(dynamicSource, 'kortix.yaml'), [
      'kortix_version: 2',
      'apps:',
      '  echo:',
      '    path: .',
      '    type: dockerfile',
      '    dockerfile: Dockerfile',
      '    command: ["bun", "/app/server.ts"]',
      '    port: 3000',
      '    readiness_path: /',
      '    env:',
      `      PLAIN_VALUE: plain-${nonce}`,
      '    secrets:',
      '      SECRET_VALUE: APP_SMOKE_SECRET',
      '',
    ].join('\n'));

    const previousCwd = process.cwd();
    process.chdir(dynamicSource);
    let dynamicV1: any;
    try {
      dynamicV1 = await cli([
        'apps', 'deploy',
        '--manifest-app', 'echo',
        '--slug', `dynamic-${nonce}`,
        '--provider', 'local-docker',
        '--wait-seconds', '1200',
        '--json',
      ]);
    } finally {
      process.chdir(previousCwd);
    }

    const dynamicGet = await publicRequest(dynamicV1.app.url);
    if (
      dynamicGet.status !== 200 ||
      dynamicGet.body?.marker !== dynamicMarkerV1 ||
      dynamicGet.body?.plain !== `plain-${nonce}` ||
      dynamicGet.body?.secret !== secretValue
    ) {
      throw new Error(`dynamic environment request failed: ${dynamicGet.status} ${dynamicGet.text}`);
    }
    const setCookie = dynamicGet.response.headers.get('set-cookie');
    const cookieGet = await publicRequest(dynamicV1.app.url, '/', {
      headers: { cookie: setCookie?.split(';')[0] ?? '' },
    });
    if (cookieGet.body?.cookie !== 'kortix-cookie=present') {
      throw new Error(`cookie forwarding failed: ${cookieGet.text}`);
    }

    const postBody = `body-${nonce}`;
    const posted = await publicRequest(dynamicV1.app.url, '/echo?query=1', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: postBody,
    });
    if (posted.status !== 200 || posted.body?.body !== postBody || posted.body?.method !== 'POST') {
      throw new Error(`POST forwarding failed: ${posted.status} ${posted.text}`);
    }
    const sse = await publicRequest(dynamicV1.app.url, '/sse');
    if (sse.status !== 200 || !sse.text.includes(`data: ${dynamicMarkerV1}`)) {
      throw new Error(`SSE forwarding failed: ${sse.status} ${sse.text}`);
    }
    await assertWebSocket(dynamicV1.app.url, dynamicMarkerV1);
    log('Dockerfile HTTP, POST, cookie, SSE, WebSocket, env, and secret paths passed', {
      deployment_id: dynamicV1.deployment.deployment_id,
    });

    const dynamicMarkerV2 = `KORTIX_APPS_DYNAMIC_V2_${nonce}`;
    await writeFile(join(dynamicSource, 'server.ts'), dynamicServer(dynamicMarkerV2));
    process.chdir(dynamicSource);
    let dynamicV2: any;
    try {
      dynamicV2 = await cli([
        'apps', 'deploy',
        '--manifest-app', 'echo',
        '--slug', `dynamic-${nonce}`,
        '--provider', 'local-docker',
        '--wait-seconds', '1200',
        '--json',
      ]);
    } finally {
      process.chdir(previousCwd);
    }
    const v2Response = await publicRequest(dynamicV2.app.url);
    if (v2Response.body?.marker !== dynamicMarkerV2) {
      throw new Error(`second deployment did not receive traffic: ${v2Response.text}`);
    }
    const rolledBack = await cli([
      'apps', 'rollback', dynamicV2.app.slug, dynamicV1.deployment.deployment_id, '--json',
    ]);
    if (rolledBack.active_deployment_id !== dynamicV1.deployment.deployment_id) {
      throw new Error(`rollback pointer mismatch: ${JSON.stringify(rolledBack)}`);
    }
    const rollbackResponse = await publicRequest(dynamicV2.app.url);
    if (rollbackResponse.body?.marker !== dynamicMarkerV1) {
      throw new Error(`rollback did not restore v1: ${rollbackResponse.text}`);
    }
    log('atomic deployment activation and rollback passed');

    const stopped = await cli(['apps', 'stop', dynamicV2.app.slug, '--json']);
    if (stopped.desired_state !== 'stopped') throw new Error(`manual stop failed: ${JSON.stringify(stopped)}`);
    const stoppedResponse = await publicRequest(dynamicV2.app.url);
    if (stoppedResponse.status !== 503 || stoppedResponse.body?.code !== 'app_stopped') {
      throw new Error(`stopped App served traffic: ${stoppedResponse.status} ${stoppedResponse.text}`);
    }
    const started = await cli(['apps', 'start', dynamicV2.app.slug, '--json']);
    if (started.desired_state !== 'running') throw new Error(`manual start failed: ${JSON.stringify(started)}`);
    const startedResponse = await publicRequest(dynamicV2.app.url);
    if (startedResponse.body?.marker !== dynamicMarkerV1) {
      throw new Error(`manual start did not restore traffic: ${startedResponse.text}`);
    }
    log('manual stop and start passed');

    await Bun.sleep(1_000);
    const [runtime] = await sql<{ runtime_id: string }[]>`
      select r.runtime_id
      from kortix.app_runtimes r
      join kortix.app_deployments d on d.deployment_id = r.deployment_id
      where d.deployment_id = ${dynamicV1.deployment.deployment_id}
      order by r.created_at desc
      limit 1
    `;
    if (!runtime?.runtime_id) throw new Error('active runtime missing');
    await sql`
      update kortix.app_runtimes
      set idle_deadline_at = now() - interval '1 second', activity_lease_until = null
      where runtime_id = ${runtime.runtime_id}
    `;
    await waitFor('idle reaper stop', async () => {
      const [row] = await sql<{ status: string }[]>`
        select status from kortix.app_runtimes where runtime_id = ${runtime.runtime_id}
      `;
      return row?.status === 'stopped';
    });
    const coldWake = await publicRequest(dynamicV2.app.url);
    if (coldWake.status !== 200 || coldWake.body?.marker !== dynamicMarkerV1) {
      throw new Error(`cold wake failed: ${coldWake.status} ${coldWake.text}`);
    }
    log('idle stop and request-driven cold wake passed', { runtime_id: runtime.runtime_id });

    await api(`/projects/${projectId}/apps/${dynamicV2.app.app_id}`, {
      method: 'PATCH',
      body: JSON.stringify({ monthly_budget_usd: 0 }),
    });
    await Bun.sleep(1_000);
    await sql`
      update kortix.app_runtimes
      set idle_deadline_at = now() - interval '1 second', activity_lease_until = null
      where runtime_id = ${runtime.runtime_id}
    `;
    await waitFor('budget test idle stop', async () => {
      const [row] = await sql<{ status: string }[]>`
        select status from kortix.app_runtimes where runtime_id = ${runtime.runtime_id}
      `;
      return row?.status === 'stopped';
    });
    const budgetResponse = await publicRequest(dynamicV2.app.url);
    if (budgetResponse.status !== 503 || budgetResponse.body?.code !== 'app_unavailable') {
      throw new Error(`budget rejection failed: ${budgetResponse.status} ${budgetResponse.text}`);
    }
    await api(`/projects/${projectId}/apps/${dynamicV2.app.app_id}`, {
      method: 'PATCH',
      body: JSON.stringify({ monthly_budget_usd: 5 }),
    });
    const afterBudget = await publicRequest(dynamicV2.app.url);
    if (afterBudget.status !== 200 || afterBudget.body?.marker !== dynamicMarkerV1) {
      throw new Error(`App did not recover after budget restore: ${afterBudget.status} ${afterBudget.text}`);
    }
    log('monthly budget rejection and recovery passed');

    const logs = await cli([
      'apps', 'logs', dynamicV2.app.slug, dynamicV1.deployment.deployment_id,
      '--limit', '200', '--json',
    ]);
    if (!Array.isArray(logs.entries) || logs.entries.length === 0) {
      throw new Error(`runtime logs are empty: ${JSON.stringify(logs)}`);
    }
    log('runtime logs passed', { entries: logs.entries.length });

    const oci = await cli([
      'apps', 'deploy',
      '--image', 'nginx:1.27-alpine',
      '--slug', `oci-${nonce}`,
      '--command', '["nginx","-g","daemon off;"]',
      '--port', '80',
      '--provider', 'local-docker',
      '--wait-seconds', '1200',
      '--json',
    ]);
    const ociResponse = await publicRequest(oci.app.url);
    if (ociResponse.status !== 200 || !/Welcome to nginx/i.test(ociResponse.text)) {
      throw new Error(`OCI request failed: ${ociResponse.status} ${ociResponse.text.slice(0, 300)}`);
    }
    log('public OCI image deployment passed', { deployment_id: oci.deployment.deployment_id });

    log('PASS', {
      project_id: projectId,
      dynamic_app_id: dynamicV2.app.app_id,
      dynamic_url: dynamicV2.app.url,
    });
  } finally {
    await sql.end({ timeout: 5 });
    await rm(source, { recursive: true, force: true });
    await rm(bundleSource, { recursive: true, force: true });
    await rm(dynamicSource, { recursive: true, force: true });
  }
}

await main();
