/**
 * `kortix audit` — the two pure pieces worth pinning.
 *
 * The rest of the command is request plumbing and terminal formatting; these
 * two decide whether the numbers a person reads are the numbers they asked for.
 *
 * `--since 24h` is the flag everyone will actually type. It resolves against
 * the caller's clock into the ISO instant the API speaks, and a value we cannot
 * parse must REFUSE rather than fall through — a time bound that silently does
 * not apply makes a partial audit read look complete, which is the one failure
 * an audit tool must not have.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { buildAuditQuery, exportBodyText, resolveInstant, truncate } from '../commands/audit.ts';

const NOW = new Date('2026-08-05T12:00:00.000Z');

describe('resolveInstant', () => {
  test.each([
    ['30m', '2026-08-05T11:30:00.000Z'],
    ['24h', '2026-08-04T12:00:00.000Z'],
    ['7d', '2026-07-29T12:00:00.000Z'],
    ['2w', '2026-07-22T12:00:00.000Z'],
  ])('%s resolves relative to now', (input, expected) => {
    expect(resolveInstant(input, NOW)).toBe(expected);
  });

  test('is case- and space-insensitive, because people type both', () => {
    expect(resolveInstant('24H', NOW)).toBe('2026-08-04T12:00:00.000Z');
    expect(resolveInstant(' 24 h ', NOW)).toBe('2026-08-04T12:00:00.000Z');
  });

  test('an ISO instant passes through normalized', () => {
    expect(resolveInstant('2026-08-01T00:00:00Z', NOW)).toBe('2026-08-01T00:00:00.000Z');
  });

  test.each([
    ['empty', ''],
    ['nonsense', 'yesterday'],
    ['unknown unit', '5y'],
    ['zero span', '0h'],
    ['negative', '-3d'],
  ])('%s is rejected, never coerced to now', (_label, input) => {
    expect(resolveInstant(input, NOW)).toBeNull();
  });
});

describe('buildAuditQuery', () => {
  test('maps CLI flag names onto the API query names', () => {
    // The flags are kebab-case for humans; the route takes snake_case. A silent
    // mismatch here would drop the filter and widen the result set.
    const built = buildAuditQuery(
      {
        action: 'iam.',
        actor: 'user-1',
        actorType: 'agent',
        project: 'proj-1',
        session: 'sess-1',
        source: 'cli',
        phase: 'completed',
        outcome: 'denied',
        resourceType: 'secret',
        requestId: 'req-1',
        correlationId: 'corr-1',
        query: 'rotate',
      },
      NOW,
    );
    expect('search' in built).toBe(true);
    const search = (built as { search: URLSearchParams }).search;
    expect(Object.fromEntries(search)).toEqual({
      action: 'iam.',
      actor: 'user-1',
      actor_type: 'agent',
      project_id: 'proj-1',
      session_id: 'sess-1',
      source: 'cli',
      phase: 'completed',
      outcome: 'denied',
      resource_type: 'secret',
      request_id: 'req-1',
      correlation_id: 'corr-1',
      q: 'rotate',
    });
  });

  test('omits every filter that was not passed', () => {
    const built = buildAuditQuery({}, NOW);
    expect([...(built as { search: URLSearchParams }).search.keys()]).toEqual([]);
  });

  test('resolves --since and --until to ISO', () => {
    const built = buildAuditQuery({ since: '24h', until: '2026-08-05T00:00:00Z' }, NOW);
    const search = (built as { search: URLSearchParams }).search;
    expect(search.get('since')).toBe('2026-08-04T12:00:00.000Z');
    expect(search.get('until')).toBe('2026-08-05T00:00:00.000Z');
  });

  test('REFUSES an unparseable --since instead of dropping it', () => {
    // The failure that matters. Dropping the bound would return events from all
    // time under a heading the user believes is scoped to a window.
    const built = buildAuditQuery({ since: 'last tuesday' }, NOW);
    expect('error' in built).toBe(true);
    expect((built as { error: string }).error).toContain('--since');
  });

  test('REFUSES an unparseable --until too', () => {
    const built = buildAuditQuery({ until: 'soon' }, NOW);
    expect('error' in built).toBe(true);
    expect((built as { error: string }).error).toContain('--until');
  });

  test('a rejected bound never leaves a partial query behind', () => {
    // If this returned the search params alongside the error, a caller that
    // ignored the error would issue an unbounded query.
    const built = buildAuditQuery({ action: 'iam.', since: 'nope' }, NOW);
    expect('search' in built).toBe(false);
  });
});

describe('audit CLI process', () => {
  test('publishes account, project, session, and resumable export commands', async () => {
    const process = Bun.spawn(['bun', 'run', 'src/index.ts', 'audit', '--help'], {
      cwd: new URL('../..', import.meta.url).pathname,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);
    expect(exitCode).toBe(0);
    expect(stderr).not.toContain('Unknown subcommand');
    expect(stdout).toContain('project <project-id>');
    expect(stdout).toContain('session <session-id>');
    expect(stdout).toContain('--cursor <c>');
    expect(stdout).toContain('--phase <p>');
  });

  test('executes filtered account, project, session, and resumable export reads', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kortix-audit-cli-'));
    const cliRoot = resolve(import.meta.dir, '..', '..');
    const cliEntry = join(cliRoot, 'src', 'index.ts');
    const requests: URL[] = [];
    const sessionId = 'd7300000-0000-4000-a000-000000000001';
    const event = (id: string, action: string) => ({
      event_id: id,
      occurred_at: '2026-08-07T12:00:00.000Z',
      project_id: 'project-1',
      session_id: sessionId,
      actor_user_id: 'user-1',
      actor_type: 'human',
      source: 'cli',
      outcome: 'success',
      action,
      resource_type: 'project_session',
      resource_id: sessionId,
      http_status: 200,
      duration_ms: 12,
      request_id: `request-${id}`,
      trace_id: null,
      correlation_id: null,
      before: null,
      after: null,
      ip: null,
      user_agent: null,
      metadata: {},
    });
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        requests.push(url);
        const cursor = url.searchParams.get('cursor');
        if (url.pathname.endsWith('/audit/export')) {
          const first = !cursor;
          return new Response(
            first
              ? 'event_id,action\nexport-1,session.created\n'
              : 'event_id,action\nexport-2,session.status.changed\n',
            {
              headers: {
                'content-type': 'text/csv',
                'x-audit-complete': first ? 'false' : 'true',
                ...(first ? { 'x-audit-next-cursor': 'export-cursor-2' } : {}),
              },
            },
          );
        }
        const scope = url.pathname.includes('/sessions/')
          ? 'session'
          : url.pathname.includes('/projects/')
            ? 'project'
            : 'account';
        return Response.json({
          events: [event(`${scope}-${cursor ? '2' : '1'}`, `${scope}.${cursor ? 'second' : 'first'}`)],
          next_cursor: cursor ? null : `${scope}-cursor-2`,
        });
      },
    });
    const configFile = join(root, 'config.json');
    writeFileSync(
      configFile,
      JSON.stringify({
        active: 'test',
        hosts: {
          test: {
            url: `http://127.0.0.1:${server.port}`,
            token: 'kortix_pat_audit_test',
            user_id: 'user-1',
            user_email: 'audit@example.test',
            account_id: 'account-1',
            logged_in_at: '2026-08-07T00:00:00.000Z',
          },
        },
      }),
    );
    async function run(args: string[]) {
      const env: Record<string, string | undefined> = {
        ...process.env,
        KORTIX_CONFIG_FILE: configFile,
        KORTIX_NO_UPDATE_CHECK: '1',
        KORTIX_DISABLE_SANDBOX_ENV_FILE: '1',
        NO_COLOR: '1',
        FORCE_COLOR: '0',
      };
      for (const key of [
        'KORTIX_API_URL',
        'KORTIX_CLI_TOKEN',
        'KORTIX_FRONTEND_URL',
        'KORTIX_PROJECT_ID',
        'KORTIX_TOKEN',
        'BASH_ENV',
      ])
        delete env[key];
      const child = Bun.spawn({
        cmd: [process.execPath, cliEntry, ...args],
        cwd: root,
        env,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { code, stdout, stderr };
    }
    try {
      const account = await run([
        'audit',
        'ls',
        '--all',
        '--json',
        '--since',
        '24h',
        '--action',
        'session.',
        '--project',
        'project-1',
        '--session',
        sessionId,
        '--source',
        'cli',
        '--phase',
        'completed',
        '--outcome',
        'success',
      ]);
      expect(account.code).toBe(0);
      expect(account.stderr).not.toContain('Error');
      expect(JSON.parse(account.stdout).events).toHaveLength(2);

      const project = await run([
        'audit',
        'project',
        'project-1',
        '--all',
        '--json',
        '--source',
        'agent',
      ]);
      expect(project.code).toBe(0);
      expect(JSON.parse(project.stdout).events).toHaveLength(2);

      const session = await run([
        'audit',
        'session',
        sessionId,
        '--project',
        'project-1',
        '--all',
        '--json',
        '--limit',
        '1',
      ]);
      expect(session.code).toBe(0);
      expect(JSON.parse(session.stdout).events).toHaveLength(2);

      const output = join(root, 'audit.csv');
      const exported = await run([
        'audit',
        'export',
        '--format',
        'csv',
        '--out',
        output,
        '--limit',
        '1',
        '--action',
        'session.',
      ]);
      expect(exported.code).toBe(0);
      expect(readFileSync(output, 'utf8')).toBe(
        'event_id,action\nexport-1,session.created\nexport-2,session.status.changed',
      );

      const accountRequests = requests.filter(
        (url) => url.pathname.endsWith('/accounts/account-1/audit') && !url.pathname.endsWith('/export'),
      );
      expect(accountRequests).toHaveLength(2);
      expect(accountRequests[0]!.searchParams.get('action')).toBe('session.');
      expect(accountRequests[0]!.searchParams.get('project_id')).toBe('project-1');
      expect(accountRequests[0]!.searchParams.get('session_id')).toBe(sessionId);
      expect(accountRequests[0]!.searchParams.get('source')).toBe('cli');
      expect(accountRequests[0]!.searchParams.get('phase')).toBe('completed');
      expect(accountRequests[0]!.searchParams.get('outcome')).toBe('success');
      expect(accountRequests[0]!.searchParams.get('since')).toMatch(/^2026-/);
      expect(accountRequests[1]!.searchParams.get('cursor')).toBe('account-cursor-2');

      const projectRequests = requests.filter(
        (url) => url.pathname.endsWith('/projects/project-1/audit'),
      );
      expect(projectRequests.map((url) => url.searchParams.get('cursor'))).toEqual([
        null,
        'project-cursor-2',
      ]);
      const sessionRequests = requests.filter((url) =>
        url.pathname.endsWith(`/projects/project-1/sessions/${sessionId}/audit`),
      );
      expect(sessionRequests.map((url) => url.searchParams.get('cursor'))).toEqual([
        null,
        'session-cursor-2',
      ]);
      const exportRequests = requests.filter((url) => url.pathname.endsWith('/audit/export'));
      expect(exportRequests.map((url) => url.searchParams.get('cursor'))).toEqual([
        null,
        'export-cursor-2',
      ]);
    } finally {
      server.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * The JSONL export came back as the string "{}" the first time it ran against
 * dev. The shared HTTP client parses `application/json`, passes `text/*`
 * through, and returns a **Blob** for anything else — and the export is
 * `application/x-ndjson`, which matches neither. `JSON.stringify(blob)` is
 * `"{}"`, so the command printed an empty object where the export belonged.
 * CSV was fine throughout (`text/csv`), which is what made it easy to miss.
 */
describe('exportBodyText', () => {
  test('a Blob body is read as text, not stringified', async () => {
    const blob = new Blob(['{"event_id":"a"}\n{"event_id":"b"}\n'], {
      type: 'application/x-ndjson',
    });
    const text = await exportBodyText(blob);
    expect(text).toContain('"event_id":"a"');
    expect(text.trim().split('\n')).toHaveLength(2);
    expect(text).not.toBe('{}');
  });

  test('a string body passes through untouched', async () => {
    expect(await exportBodyText('event_id,occurred_at\n1,2026-01-01\n')).toBe(
      'event_id,occurred_at\n1,2026-01-01\n',
    );
  });
});

describe('truncate', () => {
  test('leaves a short action alone', () => {
    expect(truncate('auth.login.success', 52)).toBe('auth.login.success');
  });

  test('caps a long action so the table keeps its shape', () => {
    // Audit actions are raw HTTP lines carrying UUIDs; uncapped, RESOURCE ended
    // up off the right edge of the terminal.
    const long = `GET /v1/accounts/${'a'.repeat(60)}`;
    const out = truncate(long, 52);
    expect(out).toHaveLength(52);
    expect(out.endsWith('…')).toBe(true);
  });
});
