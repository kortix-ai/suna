import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { kortixFromAuth, withKortixScope } from '../api/sdk.ts';
import { runSessions } from '../commands/sessions';

/**
 * Characterization of the connector-approval, pending-ask and attachment
 * commands (KRTX-4293): output and wire behavior that must hold unchanged
 * while these commands move onto the SDK. In-process, against a recording stub.
 */

const PROJECT_ID = '00000000-0000-4000-a000-000000000111';
const ACCOUNT_ID = '00000000-0000-4000-a000-000000000222';
const SESSION_ID = '00000000-0000-4000-a000-000000000333';
const ATTACHMENT_ID = '00000000-0000-4000-a000-000000000444';
const PROXY_ID = 'external-characterization';
const REF = `kortix-attachment://${PROJECT_ID}/${SESSION_ID}/${ATTACHMENT_ID}`;

const ENV_KEYS = ['KORTIX_CONFIG_FILE', 'KORTIX_TOKEN', 'KORTIX_API_URL', 'KORTIX_PROJECT_ID', 'KORTIX_DISABLE_SANDBOX_ENV_FILE'] as const;

let dir = '';
let server: ReturnType<typeof Bun.serve> | null = null;
let pendingPermissions: unknown[] = [];
let pendingQuestions: unknown[] = [];
let auditActions: unknown[] = [];
let auditSearch: string[] = [];
let approvalPosts: Array<{ path: string; body: unknown }> = [];
let approvalStatus = 200;
let attachmentStatus = 200;
let stdoutChunks: string[] = [];
let stderrChunks: string[] = [];
const savedEnv: Record<string, string | undefined> = {};
const realStdoutWrite = process.stdout.write;
const realStderrWrite = process.stderr.write;

const out = () => stdoutChunks.join('');
const err = () => stderrChunks.join('');

function sessionRow() {
  return {
    session_id: SESSION_ID,
    account_id: ACCOUNT_ID,
    project_id: PROJECT_ID,
    branch_name: SESSION_ID,
    sandbox_provider: 'daytona',
    sandbox_id: 'sandbox-row-id',
    sandbox_url: `http://127.0.0.1/v1/p/${PROXY_ID}/8000`,
    runtime_session_id: 'ses_oc',
    name: null,
    agent_name: 'default',
    status: 'running',
    error: null,
    metadata: {},
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}

const V2 = { schema: 'kortix.session/2', v: 1 } as const;
const logPage = {
  session: { ...V2, session_id: SESSION_ID, title: 'T' },
  generation: 1,
  threads: [{ ...V2, thread_id: 'ses_root', parent_thread_id: null, spawned_by: null, agent: null, title: null, created_at: '' }],
  thread_id: 'ses_root',
  has_more: false,
  messages: [
    {
      ...V2,
      message_id: 'm_u1',
      thread_id: 'ses_root',
      seq: 0,
      role: 'user',
      kind: 'turn',
      status: 'complete',
      in_context: true,
      model: null,
      usage: null,
      finish: null,
      error: null,
      created_at: '2026-01-01T00:00:00.000Z',
      completed_at: null,
      producer: { harness: 'pi', harness_version: '1', adapter_version: '1' },
      blocks: [{ type: 'attachment', id: 'b1', mime: 'text/plain', name: 'notes.txt', url: REF }],
    },
  ],
};

describe('sessions approvals / answer / attachments — characterization', () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.KORTIX_DISABLE_SANDBOX_ENV_FILE = '1';
    dir = mkdtempSync(join(tmpdir(), 'kortix-characterization-'));
    pendingPermissions = [];
    pendingQuestions = [];
    auditActions = [];
    auditSearch = [];
    approvalPosts = [];
    approvalStatus = 200;
    attachmentStatus = 200;
    stdoutChunks = [];
    stderrChunks = [];

    server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const url = new URL(req.url);
        const session = `/v1/workspaces/${PROJECT_ID}/sessions/${SESSION_ID}`;
        if (req.method === 'GET' && url.pathname === session) return Response.json(sessionRow());
        if (req.method === 'POST' && url.pathname === `${session}/start`) {
          return Response.json({ stage: 'ready', agent_name: 'default', retriable: false, sandbox: { external_id: PROXY_ID }, runtime_session_id: 'ses_oc' });
        }
        if (req.method === 'GET' && url.pathname === `/v1/p/${PROXY_ID}/8000/kortix/health`) {
          return Response.json({ capabilities: ['runtime.actions.v1'] });
        }
        if (req.method === 'GET' && url.pathname === `/v1/p/${PROXY_ID}/8000/kortix/runtime/pending`) {
          return Response.json({ statuses: { ses_oc: 'busy' }, permissions: pendingPermissions, questions: pendingQuestions });
        }
        if (req.method === 'GET' && url.pathname === `${session}/audit`) {
          auditSearch.push(url.search);
          return Response.json({ actions: auditActions });
        }
        if (req.method === 'GET' && url.pathname === `${session}/log`) return Response.json(logPage);
        if (req.method === 'GET' && url.pathname === `${session}/attachments/${ATTACHMENT_ID}`) {
          return attachmentStatus === 200 ? new Response('bytes') : Response.json({ error: 'gone' }, { status: attachmentStatus });
        }
        const approval = url.pathname.match(new RegExp(`^/v1/workspaces/${PROJECT_ID}/approvals/([^/]+)$`));
        if (req.method === 'POST' && approval) {
          approvalPosts.push({ path: approval[1] ?? '', body: await req.json() });
          return approvalStatus === 200 ? Response.json({ ok: true }) : Response.json({ error: true, message: 'Only a project manager can resolve this.' }, { status: approvalStatus });
        }
        return Response.json({ error: `not found ${url.pathname}` }, { status: 404 });
      },
    });

    const configPath = join(dir, 'config.json');
    process.env.KORTIX_CONFIG_FILE = configPath;
    writeFileSync(
      configPath,
      JSON.stringify({
        active: 'default',
        hosts: {
          default: {
            url: `http://127.0.0.1:${server.port}`,
            token: 'kortix_pat_test',
            user_id: 'user-1',
            user_email: 'user@example.test',
            account_id: ACCOUNT_ID,
            logged_in_at: '2026-01-01T00:00:00.000Z',
          },
        },
      }),
    );

    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdoutChunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrChunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(async () => {
    process.stdout.write = realStdoutWrite;
    process.stderr.write = realStderrWrite;
    if (server) {
      const auth = {
        api_base: `http://127.0.0.1:${server.port}`,
        token: 'kortix_pat_test',
        user_id: 'user-1',
        user_email: 'user@example.test',
        account_id: ACCOUNT_ID,
        logged_in_at: '2026-01-01T00:00:00.000Z',
      };
      await withKortixScope(auth, () => kortixFromAuth(auth).session(PROJECT_ID, SESSION_ID).stop()).catch(() => {});
    }
    server?.stop(true);
    server = null;
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    rmSync(dir, { recursive: true, force: true });
  });

  const permission = (id: string, name = 'bash') => ({
    id,
    thread_id: 'ses_oc',
    call_id: 'call_1',
    payload: { permission: name, patterns: ['rm -rf *'], always: [], metadata: {} },
    asked_at: '2026-01-01T00:00:00.000Z',
  });
  const question = (id: string, header: string) => ({
    id,
    thread_id: 'ses_oc',
    call_id: 'call_2',
    asked_at: '2026-01-01T00:00:00.000Z',
    payload: { questions: [{ question: 'Which environment?', header, options: [{ label: 'Staging' }] }] },
  });
  const auditAction = (over: Record<string, unknown> = {}) => ({
    execution_id: 'exec_1',
    action: 'dogfood-mcp.fetch_url',
    connector_id: 'conn_1',
    connector: 'dogfood-mcp',
    status: 'pending_approval',
    risk: 'write',
    acted_by: null,
    acted_by_email: null,
    resolved_by: null,
    resolved_by_email: null,
    result_summary: { args_preview: { url: 'https://example.test' } },
    at: '2026-01-01T00:00:00.000Z',
    resolved_at: null,
    approval_url: null,
    ...over,
  });
  const approvals = (...args: string[]) => runSessions(['approvals', SESSION_ID, ...args, '--project', PROJECT_ID]);

  describe('connector approvals', () => {
    test('ls lists only the pending_approval rows, with the risk, the args preview and the two commands', async () => {
      auditActions = [
        auditAction(),
        auditAction({ execution_id: 'exec_done', action: 'dogfood-mcp.done', status: 'success' }),
        auditAction({ execution_id: 'exec_2', action: 'dogfood-mcp.second', risk: null, result_summary: null }),
      ];
      expect(await approvals('ls')).toBe(0);
      const text = out();
      expect(text).toContain('exec_1');
      expect(text).toContain('dogfood-mcp.fetch_url');
      expect(text).toContain('args {"url":"https://example.test"}');
      expect(text).toContain(`approve: kortix sessions approvals ${SESSION_ID} approve exec_1`);
      expect(text).toContain(`deny: kortix sessions approvals ${SESSION_ID} deny exec_1`);
      expect(text).toMatch(/exec_2\s+unknown\s+dogfood-mcp\.second/);
      expect(text).not.toContain('exec_done');
      expect(text.match(/args /g)).toHaveLength(1);
    });

    test('ls --json emits the pending rows only', async () => {
      auditActions = [auditAction(), auditAction({ execution_id: 'exec_done', status: 'success' })];
      expect(await approvals('--json')).toBe(0);
      expect(JSON.parse(out()).map((a: { execution_id: string }) => a.execution_id)).toEqual(['exec_1']);
    });

    test('ls with nothing pending says so', async () => {
      auditActions = [auditAction({ status: 'success' })];
      expect(await approvals('ls')).toBe(0);
      expect(out()).toContain('No connector call is waiting on a decision.');
    });

    test('approve and deny post the decision and say what happens next', async () => {
      expect(await approvals('approve', 'exec_1')).toBe(0);
      expect(out()).toContain('Approved exec_1');
      expect(out()).toContain('the agent resumes and runs the call');
      stdoutChunks = [];
      expect(await approvals('deny', 'exec_2')).toBe(0);
      expect(out()).toContain('Denied exec_2');
      expect(out()).toContain('the agent is told and continues without it');
      expect(approvalPosts).toEqual([
        { path: 'exec_1', body: { decision: 'approve' } },
        { path: 'exec_2', body: { decision: 'deny' } },
      ]);
    });

    test('approve --json prints the execution id and the subcommand as the decision', async () => {
      expect(await approvals('approve', 'exec_1', '--json')).toBe(0);
      expect(JSON.parse(out())).toEqual({ execution_id: 'exec_1', decision: 'approve' });
    });

    test('a refused decision exits 1 with the server reason and prints no success line', async () => {
      approvalStatus = 403;
      expect(await approvals('approve', 'exec_1')).toBe(1);
      expect(err()).toContain('Only a project manager can resolve this.');
      expect(out()).toBe('');
    });

    test('approve without an execution id is a usage error before any request', async () => {
      expect(await approvals('approve')).toBe(2);
      expect(err()).toContain('needs an execution id');
      expect(approvalPosts).toEqual([]);
    });
  });

  describe('several pending asks', () => {
    test('answer without a request id lists the pending questions by id and header', async () => {
      pendingQuestions = [question('q_a', 'Environment'), question('q_b', 'Region')];
      expect(await runSessions(['answer', SESSION_ID, '--option', 'Staging', '--project', PROJECT_ID])).toBe(1);
      expect(err()).toContain('Several questions are pending — pass a request id:');
      expect(err()).toContain('  q_a  Environment\n  q_b  Region');
    });

    test('approve without a request id lists the pending permissions by id and name', async () => {
      pendingPermissions = [permission('perm_a', 'bash'), permission('perm_b', 'edit')];
      expect(await runSessions(['approve', SESSION_ID, '--project', PROJECT_ID])).toBe(1);
      expect(err()).toContain('Several permissions are pending — pass a request id:');
      expect(err()).toContain('  perm_a  bash\n  perm_b  edit');
    });

    test('nothing pending names the missing kind', async () => {
      expect(await runSessions(['approve', SESSION_ID, '--project', PROJECT_ID])).toBe(1);
      expect(err()).toContain('No pending permission on this session.');
      stderrChunks = [];
      expect(await runSessions(['answer', SESSION_ID, '--option', 'Staging', '--project', PROJECT_ID])).toBe(1);
      expect(err()).toContain('No pending question on this session.');
    });
  });

  describe('attachments', () => {
    test('a file the store cannot serve fails the download: exit 1, nothing written', async () => {
      attachmentStatus = 404;
      const outDir = join(dir, 'downloads');
      const code = await runSessions(['attachments', SESSION_ID, '--download', ATTACHMENT_ID, '--out', outDir, '--project', PROJECT_ID]);
      expect(code).toBe(1);
      expect(err()).toContain('Could not load attachment');
      expect(out()).toBe('');
      expect(existsSync(outDir) ? readdirSync(outDir) : []).toEqual([]);
    });

    test('--download of an id the transcript does not hold is a named miss', async () => {
      const code = await runSessions(['attachments', SESSION_ID, '--download', 'nope', '--project', PROJECT_ID]);
      expect(code).toBe(1);
      expect(err()).toContain(`No stored file nope in session ${SESSION_ID}.`);
    });

    test('--all writes every file and prints path and size; the table lists them otherwise', async () => {
      const outDir = join(dir, 'all');
      expect(await runSessions(['attachments', SESSION_ID, '--all', '--out', outDir, '--project', PROJECT_ID])).toBe(0);
      expect(readdirSync(outDir)).toEqual(['notes.txt']);
      expect(out()).toContain(`${join(outDir, 'notes.txt')}`);
      expect(out()).toContain('(5 bytes)');

      stdoutChunks = [];
      expect(await runSessions(['attachments', SESSION_ID, '--project', PROJECT_ID])).toBe(0);
      expect(out()).toMatch(new RegExp(`ATTACHMENT\\s+NAME\\s+FROM\\n${ATTACHMENT_ID}\\s+notes.txt\\s+user`));
      expect(out()).toContain(`kortix sessions attachments ${SESSION_ID} --download <id>`);
    });

    test('--json carries the downloaded rows next to the attachments', async () => {
      const outDir = join(dir, 'json');
      expect(await runSessions(['attachments', SESSION_ID, '--all', '--json', '--out', outDir, '--project', PROJECT_ID])).toBe(0);
      const payload = JSON.parse(out());
      expect(payload).toMatchObject({ session_id: SESSION_ID, source: 'log' });
      expect(payload.attachments.map((a: { attachment_id: string }) => a.attachment_id)).toEqual([ATTACHMENT_ID]);
      expect(payload.downloaded).toEqual([{ attachment_id: ATTACHMENT_ID, path: join(outDir, 'notes.txt'), bytes: 5 }]);
    });
  });

  describe('audit read', () => {
    test('ls asks for the pending-approvals projection, not the full timeline', async () => {
      await approvals('ls');
      expect(auditSearch).toEqual(['?include_events=false']);
    });

    test('a failed read is worded from the status, as on every CLI request', async () => {
      approvalStatus = 500;
      expect(await approvals('approve', 'exec_1')).toBe(1);
      expect(err()).toContain('HTTP 500: Only a project manager can resolve this.');
    });
  });
});
