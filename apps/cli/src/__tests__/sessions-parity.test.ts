/**
 * Blackbox coverage for the `kortix sessions` verbs added for web parity:
 * stop/start/warm, share + links, the durable prompt queue (and
 * `chat --queue`), model, connector approvals, the sandbox file surface,
 * `shell ls|kill`, `preview --list` and multi-id `rm`.
 *
 * The CLI runs as a real process against a fake Kortix API that also serves
 * the sandbox-daemon proxy paths (`/v1/p/<external-id>/8000/...`), so every
 * assertion is on the exact method + path + body that left the CLI.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI_ROOT = resolve(import.meta.dir, '..', '..');
const CLI_ENTRY = join(CLI_ROOT, 'src', 'index.ts');
const ORIGINAL_ENV = { ...process.env };

const PROJECT = '00000000-0000-4000-a000-000000000301';
const SESSION = '00000000-0000-4000-a000-000000000501';
const SESSION_B = '00000000-0000-4000-a000-000000000502';
/** Same session, but with no persisted model — exercises the compact fallback. */
const SESSION_C = '00000000-0000-4000-a000-000000000503';
const ACCOUNT = '00000000-0000-4000-a000-000000000401';
const EXECUTION = '00000000-0000-4000-a000-000000000601';
const PROMPT_ROW = '00000000-0000-4000-a000-000000000701';
const SHARE = '00000000-0000-4000-a000-000000000801';
const EXTERNAL = 'sandbox-parity';

interface Seen {
  method: string;
  path: string;
  body?: unknown;
}

let tmp: string;
let server: ReturnType<typeof Bun.serve> | null = null;
let seen: Seen[] = [];

function sessionRow(sessionId = SESSION) {
  return {
    session_id: sessionId,
    account_id: ACCOUNT,
    project_id: PROJECT,
    branch_name: sessionId,
    base_ref: 'main',
    sandbox_provider: 'daytona',
    sandbox_id: 'sandbox-row-id',
    sandbox_url: `http://127.0.0.1/v1/p/${EXTERNAL}/8000`,
    opencode_session_id: 'ses_oc',
    name: 'Parity',
    custom_name: null,
    agent_name: 'kortix',
    status: 'running',
    error: null,
    metadata: { opencode_model: 'kortix/glm-5.3-flash' },
    sharing: { mode: 'private', ownerId: 'user-1' },
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}

function publicShare(overrides: Record<string, unknown> = {}) {
  return {
    share_id: SHARE,
    session_id: SESSION,
    project_id: PROJECT,
    resource_type: 'preview',
    label: 'App preview',
    port: 3000,
    path: '/',
    file_path: null,
    mode: 'view',
    allow_websocket: false,
    expires_at: null,
    revoked_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    public_token: 'kps_abc',
    public_path: '/share/session/kps_abc',
    proxy_path: '/v1/p/public-share/kps_abc/3000/',
    public_url: 'https://p3000-sandbox-parity.example.test/?public_share=kps_abc',
    ...overrides,
  };
}

function queuedPrompt() {
  return {
    prompt_id: PROMPT_ROW,
    client_message_id: 'cmid-1',
    message_id: 'msg_00000000000abcdefghijklmn',
    state: 'queued',
    reason: 'older_prompt_pending',
    text: 'ship the thing',
    attempts: 0,
    last_error: null,
    created_at: '2026-01-01T00:00:00.000Z',
    available_at: '2026-01-01T00:00:00.000Z',
  };
}

async function bodyOf(req: Request): Promise<unknown> {
  const type = req.headers.get('content-type') ?? '';
  if (type.includes('application/json')) return req.json().catch(() => null);
  if (type.includes('multipart/form-data')) {
    const form = await req.formData();
    const out: Record<string, unknown> = {};
    for (const [key, value] of form.entries()) {
      out[key] = typeof value === 'string' ? value : `<file:${(value as File).name}>`;
    }
    return out;
  }
  return null;
}

function startServer(): string {
  const daemon = `/v1/p/${EXTERNAL}/8000`;
  server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      const path = url.pathname;
      const method = req.method;
      const body = method === 'GET' || method === 'DELETE' ? undefined : await bodyOf(req);
      seen.push({ method, path: path + url.search, body });
      const project = `/v1/projects/${PROJECT}`;
      const session = `${project}/sessions/${SESSION}`;

      // ── control plane ────────────────────────────────────────────────────
      if (method === 'GET' && path === `${project}/sessions/${SESSION}`) {
        return Response.json(sessionRow());
      }
      if (method === 'GET' && path === `${project}/sessions/${SESSION_B}`) {
        return Response.json(sessionRow(SESSION_B));
      }
      if (method === 'GET' && path === `${project}/sessions/${SESSION_C}`) {
        return Response.json({ ...sessionRow(SESSION_C), metadata: {} });
      }
      if (method === 'POST' && path === `${project}/sessions/${SESSION_C}/start`) {
        return Response.json({
          stage: 'ready',
          agent_name: 'kortix',
          retriable: false,
          sandbox: { external_id: EXTERNAL },
          opencode_session_id: 'ses_oc',
        });
      }
      if (method === 'POST' && path === `${session}/start`) {
        return Response.json({
          stage: 'ready',
          agent_name: 'kortix',
          retriable: false,
          sandbox: { external_id: EXTERNAL },
          opencode_session_id: 'ses_oc',
        });
      }
      if (method === 'POST' && path === `${session}/stop`) {
        return Response.json({ ok: true, session_id: SESSION, status: 'stopped' });
      }
      if (method === 'POST' && path === `${project}/sessions/warm`) {
        return Response.json({
          session: sessionRow(SESSION_B),
          reused: false,
          workspace_refresh: { status: 'updated' },
        });
      }
      if (method === 'PUT' && path === `${session}/sharing`) {
        return Response.json({ ...sessionRow(), sharing: (body as { mode: string }) ?? null });
      }
      if (method === 'GET' && path === `${project}/access`) {
        return Response.json({
          members: [{ user_id: 'user-42', email: 'dev@example.test' }],
          can_manage: true,
        });
      }
      if (path === `${session}/public-shares` && method === 'GET') {
        return Response.json({ shares: [publicShare()] });
      }
      if (path === `${session}/public-shares` && method === 'POST') {
        return Response.json({ share: publicShare() }, { status: 201 });
      }
      if (method === 'DELETE' && path === `${session}/public-shares/${SHARE}`) {
        return Response.json({ share: publicShare({ revoked_at: '2026-01-02T00:00:00.000Z' }) });
      }
      if (method === 'GET' && path === `${session}/previews`) {
        return Response.json({
          candidates: [
            { id: 'web', label: 'App preview', port: 3000, path: '/', status: 'unknown' },
            { id: 'vite', label: 'Frontend preview', port: 5173, path: '/', status: 'unknown' },
          ],
        });
      }
      if (method === 'GET' && path === `${session}/prompts`) {
        return Response.json({ prompts: [queuedPrompt()] });
      }
      if (method === 'POST' && path === `${session}/prompts`) {
        return Response.json(
          { prompt_id: PROMPT_ROW, state: 'queued', message_id: 'msg_reminted', deduped: false },
          { status: 202 },
        );
      }
      if (method === 'DELETE' && path === `${session}/prompts/${PROMPT_ROW}`) {
        return Response.json({ removed: { prompt_id: PROMPT_ROW, parts: [] } });
      }
      if (method === 'POST' && path === `${session}/prompts/${PROMPT_ROW}/retry`) {
        return Response.json({ ...queuedPrompt(), state: 'queued', reason: null });
      }
      if (method === 'POST' && path === `${session}/prompts/hold`) {
        return Response.json({ prompts: [queuedPrompt()] });
      }
      if (method === 'PUT' && path === `${session}/model`) {
        const model = (body as { opencode_model: string }).opencode_model;
        if (model === 'kortix/wedged') {
          return Response.json({
            opencode_model: model,
            applied_live: false,
            push_failed: true,
            detail: 'env sync failed',
          });
        }
        if (model === 'kortix/nope') {
          return Response.json({ error: 'Model is not available for this account' }, { status: 400 });
        }
        return Response.json({ opencode_model: model, applied_live: true });
      }
      if (method === 'GET' && path === `${session}/audit`) {
        return Response.json({
          session_id: SESSION,
          count: 2,
          actions: [
            {
              execution_id: EXECUTION,
              action: 'send_message',
              connector: 'slack',
              connector_id: 'conn-1',
              status: 'pending_approval',
              risk: 'write',
              acted_by_email: 'dev@example.test',
              result_summary: { args_preview: { channel: '#general' } },
              at: '2026-01-01T00:00:00.000Z',
            },
            {
              execution_id: 'other',
              action: 'read',
              connector: 'slack',
              connector_id: 'conn-1',
              status: 'ok',
              risk: 'read',
              acted_by_email: null,
              result_summary: null,
              at: '2026-01-01T00:00:00.000Z',
            },
          ],
        });
      }
      if (method === 'POST' && path === `${project}/approvals/${EXECUTION}`) {
        return Response.json({ ok: true });
      }
      if (method === 'DELETE' && path === `${project}/sessions/${SESSION}`) {
        return Response.json({ ok: true });
      }
      if (method === 'DELETE' && path === `${project}/sessions/${SESSION_B}`) {
        return Response.json({ error: 'Only the session owner can delete this' }, { status: 403 });
      }

      // ── sandbox daemon (through the /v1/p proxy) ─────────────────────────
      if (method === 'GET' && path === `${daemon}/file`) {
        return Response.json([
          { name: 'report.md', path: 'out/report.md', absolute: '/workspace/out/report.md', type: 'file', ignored: false },
          { name: 'assets', path: 'out/assets', absolute: '/workspace/out/assets', type: 'directory', ignored: false },
        ]);
      }
      if (method === 'GET' && path === `${daemon}/file/status`) {
        return Response.json([{ path: 'out/report.md', added: 12, removed: 3, status: 'modified' }]);
      }
      if (method === 'GET' && path === `${daemon}/find/file`) {
        return Response.json(['/workspace/out/report.md']);
      }
      if (method === 'GET' && path === `${daemon}/find`) {
        return Response.json([
          { path: 'out/report.md', lines: 'report line\n', line_number: 4, absolute_offset: 0, submatches: [] },
        ]);
      }
      if (method === 'POST' && path === `${daemon}/file/mkdir`) return Response.json(true);
      if (method === 'POST' && path === `${daemon}/file/rename`) return Response.json(true);
      if (method === 'DELETE' && path === `${daemon}/file`) return Response.json(true);
      if (method === 'POST' && path === `${daemon}/file/upload`) {
        const form = (body ?? {}) as Record<string, unknown>;
        const parent = typeof form.path === 'string' ? form.path : '/workspace';
        const name = typeof form.filename === 'string' ? form.filename : 'uploaded';
        return Response.json([{ path: `${parent}/${name}`.replace('//', '/'), size: 5 }]);
      }
      if (method === 'POST' && path === `${daemon}/session/ses_oc/summarize`) {
        return Response.json({});
      }
      if (method === 'GET' && path === `${daemon}/kortix/pty`) {
        return Response.json([
          {
            id: 'pty_1',
            title: 'Session terminal',
            command: 'bash',
            args: ['-l'],
            cwd: '/workspace',
            status: 'running',
            pid: 4242,
          },
        ]);
      }
      if (method === 'DELETE' && path === `${daemon}/kortix/pty/pty_1`) {
        return new Response(null, { status: 204 });
      }

      return Response.json({ error: `not found ${method} ${path}` }, { status: 404 });
    },
  });
  return `http://127.0.0.1:${server.port}`;
}

function writeConfig(apiBase: string): string {
  const path = join(tmp, 'config.json');
  writeFileSync(
    path,
    JSON.stringify({
      active: 'test',
      hosts: {
        test: {
          url: apiBase,
          token: 'kortix_pat_parity',
          user_id: 'user-1',
          user_email: 'user@example.test',
          account_id: ACCOUNT,
          logged_in_at: '2026-01-01T00:00:00.000Z',
        },
      },
    }),
    'utf8',
  );
  return path;
}

async function runCli(
  args: string[],
  configFile?: string,
  stdin?: Blob,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    KORTIX_NO_UPDATE_CHECK: '1',
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    KORTIX_DISABLE_SANDBOX_ENV_FILE: '1',
    KORTIX_CONFIG_FILE: configFile,
  };
  for (const key of [
    'KORTIX_API_URL',
    'KORTIX_CLI_TOKEN',
    'KORTIX_FRONTEND_URL',
    'KORTIX_PROJECT_ID',
    'KORTIX_TOKEN',
    'BASH_ENV',
  ]) {
    delete env[key];
  }
  const proc = Bun.spawn({
    cmd: [process.execPath, CLI_ENTRY, ...args],
    cwd: tmp,
    env,
    stdin: stdin ?? 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timeout = setTimeout(() => proc.kill(), 20_000);
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]).finally(() => clearTimeout(timeout));
  return { code, stdout, stderr };
}

/** Every request the CLI made to one method+path prefix. */
function calls(method: string, prefix: string): Seen[] {
  return seen.filter((s) => s.method === method && s.path.startsWith(prefix));
}

let config = '';

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'kortix-sessions-parity-'));
  process.env = { ...ORIGINAL_ENV };
  seen = [];
  config = writeConfig(startServer());
});

afterEach(() => {
  server?.stop(true);
  server = null;
  rmSync(tmp, { recursive: true, force: true });
  process.env = { ...ORIGINAL_ENV };
});

const P = ['--project', PROJECT];

describe('kortix sessions — help', () => {
  test('documents every new subcommand', async () => {
    const r = await runCli(['sessions', '--help']);
    expect(r.code).toBe(0);
    for (const fragment of [
      'stop <session-id>',
      'start <session-id>',
      'warm',
      'model <session-id> <model-id>',
      'compact <session-id>',
      'queue <session-id>',
      'approvals <session-id>',
      'share <session-id>',
      'links <session-id>',
      'files <session-id>',
      'rm <session-id>...',
    ]) {
      expect(r.stdout).toContain(fragment);
    }
  });

  test('no arguments exits 2 with the help', async () => {
    const r = await runCli(['sessions']);
    expect(r.code).toBe(2);
    expect(r.stdout).toContain('Usage: kortix sessions');
  });
});

describe('kortix sessions stop / start / warm', () => {
  test('stop POSTs /stop and reports the resumable pause', async () => {
    const r = await runCli(['sessions', 'stop', SESSION, ...P], config);
    expect(r.code).toBe(0);
    expect(calls('POST', `/v1/projects/${PROJECT}/sessions/${SESSION}/stop`)).toEqual([
      { method: 'POST', path: `/v1/projects/${PROJECT}/sessions/${SESSION}/stop`, body: {} },
    ]);
    expect(r.stdout).toContain('Stopped');
    expect(r.stdout).toContain('disk kept');
  });

  test('start POSTs /start once and reports ready', async () => {
    const r = await runCli(['sessions', 'start', SESSION, ...P], config);
    expect(r.code).toBe(0);
    expect(calls('POST', `/v1/projects/${PROJECT}/sessions/${SESSION}/start`)).toHaveLength(1);
    expect(r.stdout).toContain('is ready');
  });

  test('start --wait returns 0 immediately on a ready session', async () => {
    const r = await runCli(['sessions', 'start', SESSION, '--wait', '--json', ...P], config);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).stage).toBe('ready');
  });

  test('start without a session id exits 2', async () => {
    const r = await runCli(['sessions', 'start', ...P], config);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('Pass a session id');
  });

  test('warm POSTs /sessions/warm with the exclusion', async () => {
    const r = await runCli(['sessions', 'warm', '--exclude', SESSION, '--json', ...P], config);
    expect(r.code).toBe(0);
    expect(calls('POST', `/v1/projects/${PROJECT}/sessions/warm`)).toEqual([
      {
        method: 'POST',
        path: `/v1/projects/${PROJECT}/sessions/warm`,
        body: { exclude_session_id: SESSION },
      },
    ]);
    expect(JSON.parse(r.stdout).reused).toBe(false);
  });
});

describe('kortix sessions share', () => {
  test('--show prints the stored sharing without writing', async () => {
    const r = await runCli(['sessions', 'share', SESSION, '--show', '--json', ...P], config);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({
      session_id: SESSION,
      sharing: { mode: 'private', ownerId: 'user-1' },
    });
    expect(calls('PUT', `/v1/projects/${PROJECT}`)).toEqual([]);
  });

  test('--mode project PUTs the project intent', async () => {
    const r = await runCli(['sessions', 'share', SESSION, '--mode', 'project', ...P], config);
    expect(r.code).toBe(0);
    expect(calls('PUT', `/v1/projects/${PROJECT}/sessions/${SESSION}/sharing`)).toEqual([
      {
        method: 'PUT',
        path: `/v1/projects/${PROJECT}/sessions/${SESSION}/sharing`,
        body: { mode: 'project' },
      },
    ]);
    expect(r.stdout).toContain('every project member');
  });

  test('--member accepts an email and resolves it through the member list', async () => {
    const r = await runCli(
      ['sessions', 'share', SESSION, '--mode', 'members', '--member', 'dev@example.test', '--group', 'grp-7', ...P],
      config,
    );
    expect(r.code).toBe(0);
    expect(calls('GET', `/v1/projects/${PROJECT}/access`)).toHaveLength(1);
    expect(calls('PUT', `/v1/projects/${PROJECT}/sessions/${SESSION}/sharing`)[0]?.body).toEqual({
      mode: 'members',
      memberIds: ['user-42'],
      groupIds: ['grp-7'],
    });
  });

  test('--mode private sends the empty ownerId the dashboard sends', async () => {
    const r = await runCli(['sessions', 'share', SESSION, '--mode', 'private', ...P], config);
    expect(r.code).toBe(0);
    expect(calls('PUT', `/v1/projects/${PROJECT}/sessions/${SESSION}/sharing`)[0]?.body).toEqual({
      mode: 'private',
      ownerId: '',
    });
  });

  test('--mode members with no subject exits 2 instead of publishing project-wide', async () => {
    const r = await runCli(['sessions', 'share', SESSION, '--mode', 'members', ...P], config);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('needs at least one --member or --group');
  });

  test('an unknown email exits 1 without writing', async () => {
    const r = await runCli(
      ['sessions', 'share', SESSION, '--mode', 'members', '--member', 'nobody@example.test', ...P],
      config,
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('No project member with email');
    expect(calls('PUT', `/v1/projects/${PROJECT}`)).toEqual([]);
  });
});

describe('kortix sessions links', () => {
  test('create POSTs a preview share and prints the public url', async () => {
    const r = await runCli(
      ['sessions', 'links', SESSION, 'create', '--port', '3000', '--path', '/app', ...P],
      config,
    );
    expect(r.code).toBe(0);
    expect(calls('POST', `/v1/projects/${PROJECT}/sessions/${SESSION}/public-shares`)[0]?.body).toEqual({
      preview: { port: 3000, path: '/app' },
    });
    expect(r.stdout).toContain('https://p3000-sandbox-parity.example.test/?public_share=kps_abc');
  });

  test('create --file shares one workspace document', async () => {
    const r = await runCli(
      ['sessions', 'links', SESSION, 'create', '--file', 'out/report.pdf', '--mode', 'view', ...P],
      config,
    );
    expect(r.code).toBe(0);
    expect(calls('POST', `/v1/projects/${PROJECT}/sessions/${SESSION}/public-shares`)[0]?.body).toEqual({
      file: { path: 'out/report.pdf' },
      mode: 'view',
    });
  });

  test('ls lists shares; --json emits the rows verbatim', async () => {
    const r = await runCli(['sessions', 'links', SESSION, 'ls', '--json', ...P], config);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)[0].share_id).toBe(SHARE);
  });

  test('revoke DELETEs the share', async () => {
    const r = await runCli(['sessions', 'links', SESSION, 'revoke', SHARE, ...P], config);
    expect(r.code).toBe(0);
    expect(calls('DELETE', `/v1/projects/${PROJECT}/sessions/${SESSION}/public-shares/${SHARE}`)).toHaveLength(1);
    expect(r.stdout).toContain('Revoked');
  });

  test('revoke without a share id exits 2', async () => {
    const r = await runCli(['sessions', 'links', SESSION, 'revoke', ...P], config);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('Pass a share id');
  });
});

describe('kortix sessions queue', () => {
  test('ls prints the waiting prompts with their reason', async () => {
    const r = await runCli(['sessions', 'queue', SESSION, 'ls', ...P], config);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(PROMPT_ROW);
    expect(r.stdout).toContain('older_prompt_pending');
    expect(r.stdout).toContain('ship the thing');
  });

  test('hold POSTs { held: true }, release POSTs { held: false }', async () => {
    expect((await runCli(['sessions', 'queue', SESSION, 'hold', ...P], config)).code).toBe(0);
    expect((await runCli(['sessions', 'queue', SESSION, 'release', ...P], config)).code).toBe(0);
    expect(
      calls('POST', `/v1/projects/${PROJECT}/sessions/${SESSION}/prompts/hold`).map((c) => c.body),
    ).toEqual([{ held: true }, { held: false }]);
  });

  test('now retries the row; rm deletes it', async () => {
    const now = await runCli(['sessions', 'queue', SESSION, 'now', PROMPT_ROW, ...P], config);
    expect(now.code).toBe(0);
    expect(
      calls('POST', `/v1/projects/${PROJECT}/sessions/${SESSION}/prompts/${PROMPT_ROW}/retry`),
    ).toHaveLength(1);

    const rm = await runCli(['sessions', 'queue', SESSION, 'rm', PROMPT_ROW, ...P], config);
    expect(rm.code).toBe(0);
    expect(
      calls('DELETE', `/v1/projects/${PROJECT}/sessions/${SESSION}/prompts/${PROMPT_ROW}`),
    ).toHaveLength(1);
  });

  test('rm without a prompt id exits 2', async () => {
    const r = await runCli(['sessions', 'queue', SESSION, 'rm', ...P], config);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('needs a prompt id');
  });

  test('an unknown subcommand exits 2 with the help', async () => {
    const r = await runCli(['sessions', 'queue', SESSION, 'nope', ...P], config);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('unknown subcommand "nope"');
  });
});

describe('kortix sessions chat --queue', () => {
  test('posts to the durable inbox with a wire message id and the session defaults', async () => {
    const r = await runCli(
      ['sessions', 'chat', SESSION, '-p', 'ship the thing', '--queue', '--json', ...P],
      config,
    );
    expect(r.code).toBe(0);
    const post = calls('POST', `/v1/projects/${PROJECT}/sessions/${SESSION}/prompts`)[0];
    const body = post?.body as {
      client_message_id: string;
      message_id: string;
      parts: unknown[];
      overrides: unknown;
      client_sent_at_ms: number;
    };
    // The API refuses anything that is not an OpenCode wire message id.
    expect(body.message_id).toMatch(/^msg_[0-9a-f]{12}[A-Za-z0-9]{14}$/);
    expect(body.client_message_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.parts).toEqual([{ type: 'text', text: 'ship the thing' }]);
    expect(body.overrides).toEqual({
      agent: 'kortix',
      model: { providerID: 'kortix', modelID: 'glm-5.3-flash' },
    });
    expect(typeof body.client_sent_at_ms).toBe('number');
    expect(JSON.parse(r.stdout).prompt_id).toBe(PROMPT_ROW);
  });

  test('--queue never touches the runtime (no /start, no daemon call)', async () => {
    await runCli(['sessions', 'chat', SESSION, '-p', 'x', '--queue', ...P], config);
    expect(calls('POST', `/v1/projects/${PROJECT}/sessions/${SESSION}/start`)).toEqual([]);
    expect(seen.filter((s) => s.path.startsWith(`/v1/p/${EXTERNAL}`))).toEqual([]);
  });

  test('--queue without --prompt exits 2', async () => {
    const r = await runCli(['sessions', 'chat', SESSION, '--queue', ...P], config);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--queue needs --prompt');
  });
});

describe('kortix sessions model', () => {
  test('PUTs the model and reports the live application', async () => {
    const r = await runCli(['sessions', 'model', SESSION, 'kortix/glm-5.3-flash', ...P], config);
    expect(r.code).toBe(0);
    expect(calls('PUT', `/v1/projects/${PROJECT}/sessions/${SESSION}/model`)).toEqual([
      {
        method: 'PUT',
        path: `/v1/projects/${PROJECT}/sessions/${SESSION}/model`,
        body: { opencode_model: 'kortix/glm-5.3-flash' },
      },
    ]);
    expect(r.stdout).toContain('Now running kortix/glm-5.3-flash');
  });

  test('push_failed is an error, not a success', async () => {
    const r = await runCli(['sessions', 'model', SESSION, 'kortix/wedged', ...P], config);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('live push FAILED');
  });

  test('a 400 from the API exits 1 with the server reason', async () => {
    const r = await runCli(['sessions', 'model', SESSION, 'kortix/nope', ...P], config);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Model is not available for this account');
  });

  test('a missing model id exits 2', async () => {
    const r = await runCli(['sessions', 'model', SESSION, ...P], config);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('Pass a model id');
  });
});

describe('kortix sessions compact', () => {
  test('summarizes through the runtime with the session own persisted model', async () => {
    const r = await runCli(['sessions', 'compact', SESSION, '--json', ...P], config);
    expect(r.code).toBe(0);
    const call = calls('POST', `/v1/p/${EXTERNAL}/8000/session/ses_oc/summarize`)[0];
    expect(call?.body).toEqual({ providerID: 'kortix', modelID: 'glm-5.3-flash' });
    expect(JSON.parse(r.stdout).model).toBe('kortix/glm-5.3-flash');
  });

  test('a session with no resolvable model exits 1 instead of guessing one', async () => {
    const r = await runCli(['sessions', 'compact', SESSION_C, ...P], config);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('No model configured for this session');
    expect(calls('POST', `/v1/p/${EXTERNAL}/8000/session/ses_oc/summarize`)).toEqual([]);
  });

  test('without a session id exits 2', async () => {
    const r = await runCli(['sessions', 'compact', ...P], config);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('Pass a session id');
  });
});

describe('kortix sessions approvals', () => {
  test('ls shows only the pending_approval rows, with their arguments', async () => {
    const r = await runCli(['sessions', 'approvals', SESSION, 'ls', ...P], config);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(EXECUTION);
    expect(r.stdout).toContain('slack.send_message');
    expect(r.stdout).toContain('#general');
    expect(r.stdout).not.toContain('other');
  });

  test('approve POSTs the decision to the project approvals route', async () => {
    const r = await runCli(['sessions', 'approvals', SESSION, 'approve', EXECUTION, ...P], config);
    expect(r.code).toBe(0);
    expect(calls('POST', `/v1/projects/${PROJECT}/approvals/${EXECUTION}`)).toEqual([
      {
        method: 'POST',
        path: `/v1/projects/${PROJECT}/approvals/${EXECUTION}`,
        body: { decision: 'approve' },
      },
    ]);
  });

  test('deny sends decision: deny', async () => {
    await runCli(['sessions', 'approvals', SESSION, 'deny', EXECUTION, ...P], config);
    expect(calls('POST', `/v1/projects/${PROJECT}/approvals/${EXECUTION}`)[0]?.body).toEqual({
      decision: 'deny',
    });
  });

  test('approve without an execution id exits 2', async () => {
    const r = await runCli(['sessions', 'approvals', SESSION, 'approve', ...P], config);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('needs an execution id');
  });
});

describe('kortix sessions files', () => {
  const daemon = `/v1/p/${EXTERNAL}/8000`;

  test('ls reads the daemon file listing for the resolved sandbox', async () => {
    const r = await runCli(['sessions', 'files', SESSION, 'ls', 'out', '--json', ...P], config);
    expect(r.code).toBe(0);
    expect(calls('GET', `${daemon}/file?path=out`)).toHaveLength(1);
    expect(JSON.parse(r.stdout).map((n: { name: string }) => n.name)).toEqual([
      'report.md',
      'assets',
    ]);
  });

  test('status prints the git working-tree diff counts', async () => {
    const r = await runCli(['sessions', 'files', SESSION, 'status', ...P], config);
    expect(r.code).toBe(0);
    expect(calls('GET', `${daemon}/file/status`)).toHaveLength(1);
    expect(r.stdout).toContain('out/report.md');
    expect(r.stdout).toContain('+12');
  });

  test('find searches filenames, --content searches contents', async () => {
    expect((await runCli(['sessions', 'files', SESSION, 'find', 'report', ...P], config)).code).toBe(0);
    expect(calls('GET', `${daemon}/find/file?query=report`)).toHaveLength(1);

    const grep = await runCli(
      ['sessions', 'files', SESSION, 'find', 'report', '--content', ...P],
      config,
    );
    expect(grep.code).toBe(0);
    expect(calls('GET', `${daemon}/find?pattern=report`)).toHaveLength(1);
    expect(grep.stdout).toContain('out/report.md:4');
  });

  test('mkdir, mv and rm hit the daemon write routes with absolute paths', async () => {
    expect((await runCli(['sessions', 'files', SESSION, 'mkdir', 'out/new', ...P], config)).code).toBe(0);
    expect(calls('POST', `${daemon}/file/mkdir`)[0]?.body).toEqual({ path: '/workspace/out/new' });

    expect((await runCli(['sessions', 'files', SESSION, 'mv', 'a.txt', 'b.txt', ...P], config)).code).toBe(0);
    expect(calls('POST', `${daemon}/file/rename`)[0]?.body).toEqual({
      from: '/workspace/a.txt',
      to: '/workspace/b.txt',
    });

    expect((await runCli(['sessions', 'files', SESSION, 'rm', 'a.txt', '-y', ...P], config)).code).toBe(0);
    expect(calls('DELETE', `${daemon}/file`)).toHaveLength(1);
  });

  test('write --from uploads to a temp name, then renames it onto the target', async () => {
    const local = join(tmp, 'payload.txt');
    writeFileSync(local, 'hello', 'utf8');
    const r = await runCli(
      ['sessions', 'files', SESSION, 'write', 'out/note.txt', '--from', local, '--json', ...P],
      config,
    );
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).path).toBe('/workspace/out/note.txt');

    const upload = calls('POST', `${daemon}/file/upload`)[0]?.body as Record<string, string>;
    expect(upload.path).toBe('/workspace/out');
    expect(upload.filename).toMatch(/^\.note\.txt\.kortix-write-/);
    // Backup the target, move the temp into place, drop the backup.
    const renames = calls('POST', `${daemon}/file/rename`).map((c) => c.body as { from: string; to: string });
    expect(renames.some((r2) => r2.to === '/workspace/out/note.txt')).toBe(true);
    expect(calls('DELETE', `${daemon}/file`)).toHaveLength(1);
  });

  test('write reads stdin when there is no --from', async () => {
    const r = await runCli(
      ['sessions', 'files', SESSION, 'write', 'out/piped.txt', '--json', ...P],
      config,
      new Blob(['piped bytes']),
    );
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).path).toBe('/workspace/out/piped.txt');
    expect(calls('POST', `${daemon}/file/upload`)).toHaveLength(1);
  });

  test('touch creates an empty file', async () => {
    const r = await runCli(['sessions', 'files', SESSION, 'touch', 'out/empty.txt', ...P], config);
    expect(r.code).toBe(0);
    expect(calls('POST', `${daemon}/file/upload`)).toHaveLength(1);
  });

  test('a missing subcommand exits 2 with the help', async () => {
    const r = await runCli(['sessions', 'files', SESSION, ...P], config);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('Pass a session id and a subcommand');
  });

  test('mv without a destination exits 2', async () => {
    const r = await runCli(['sessions', 'files', SESSION, 'mv', 'a.txt', ...P], config);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('needs <from> and <to>');
  });
});

describe('kortix sessions shell ls|kill', () => {
  const daemon = `/v1/p/${EXTERNAL}/8000`;

  test('ls lists the session terminals without a TTY', async () => {
    const r = await runCli(['sessions', 'shell', SESSION, 'ls', '--json', ...P], config);
    expect(r.code).toBe(0);
    expect(calls('GET', `${daemon}/kortix/pty`)).toHaveLength(1);
    expect(JSON.parse(r.stdout)[0].id).toBe('pty_1');
  });

  test('kill DELETEs the pty', async () => {
    const r = await runCli(['sessions', 'shell', SESSION, 'kill', 'pty_1', ...P], config);
    expect(r.code).toBe(0);
    expect(calls('DELETE', `${daemon}/kortix/pty/pty_1`)).toHaveLength(1);
    expect(r.stdout).toContain('Killed terminal pty_1');
  });

  test('kill without a pty id exits 2', async () => {
    const r = await runCli(['sessions', 'shell', SESSION, 'kill', ...P], config);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('needs a pty id');
  });
});

describe('kortix sessions preview --list', () => {
  test('prints the named candidates instead of one url', async () => {
    const r = await runCli(['sessions', 'preview', SESSION, '--list', '--json', ...P], config);
    expect(r.code).toBe(0);
    expect(calls('GET', `/v1/projects/${PROJECT}/sessions/${SESSION}/previews`)).toHaveLength(1);
    expect(JSON.parse(r.stdout).map((c: { id: string }) => c.id)).toEqual(['web', 'vite']);
  });

  test('without --list the default single-port behavior is unchanged', async () => {
    const r = await runCli(['sessions', 'preview', SESSION, '--json', ...P], config);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.port).toBe(3000);
    expect(out.sandbox).toBe(EXTERNAL);
    expect(calls('GET', `/v1/projects/${PROJECT}/sessions/${SESSION}/previews`)).toEqual([]);
  });
});

describe('kortix sessions rm (multiple ids)', () => {
  test('deletes each id and reports the failures, exiting 1', async () => {
    const r = await runCli(['sessions', 'rm', SESSION, SESSION_B, ...P], config);
    expect(r.code).toBe(1);
    expect(calls('DELETE', `/v1/projects/${PROJECT}/sessions/${SESSION}`)).toHaveLength(1);
    expect(calls('DELETE', `/v1/projects/${PROJECT}/sessions/${SESSION_B}`)).toHaveLength(1);
    expect(r.stdout).toContain('Deleted');
    expect(r.stderr).toContain('1 of 2 sessions could not be deleted');
  });

  test('one id still works and exits 0', async () => {
    const r = await runCli(['sessions', 'rm', SESSION, ...P], config);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Deleted');
  });

  test('no id exits 2', async () => {
    const r = await runCli(['sessions', 'rm', ...P], config);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('Pass a session id');
  });
});
