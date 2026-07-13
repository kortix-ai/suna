import { describe, expect, test } from 'bun:test';
import { type ExecutionLeaseContext, ExecutionLeaseReporter } from '../execution-lease';

const context: ExecutionLeaseContext = {
  projectId: 'project-1',
  sessionId: 'session-1',
  token: 'kortix_sb_test',
  apiRoot: 'https://api.test/v1',
};
const response = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });

describe('ExecutionLeaseReporter', () => {
  test('touches both provider and API while busy', async () => {
    const calls: Array<{ url: string; kind?: string; headers?: RequestInit['headers'] }> = [];
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? (JSON.parse(String(init.body)) as { kind?: string }) : {};
      calls.push({ url, kind: body.kind, headers: init?.headers });
      return url.startsWith('https://api.test/')
        ? response({
            provider_url: 'https://edge.test',
            provider_headers: { 'X-Daytona-Preview-Token': 'preview-secret', Authorization: 'drop-me' },
          })
        : response({ status: 'ok' });
    }) as typeof fetch;
    const reporter = new ExecutionLeaseReporter(context, { fetchFn, heartbeatIntervalMs: 5 });
    reporter.discover();
    reporter.markBusy('root');
    await reporter.settled();
    await Bun.sleep(12);
    reporter.markInactive('root');
    await reporter.settled();
    expect(calls.some((call) => call.kind === 'execution_heartbeat')).toBe(true);
    expect(calls.some((call) => call.kind === 'execution_lease_release')).toBe(true);
    const direct = calls.find((call) => call.url === 'https://edge.test/kortix/health');
    expect(direct).toBeDefined();
    expect(direct?.headers).toMatchObject({
      'X-Daytona-Preview-Token': 'preview-secret',
      Authorization: 'Bearer kortix_sb_test',
    });
  });
  test('holds the lease until every root/subagent is inactive', async () => {
    const kinds: string[] = [];
    const fetchFn = (async (_input: string | URL | Request, init?: RequestInit) => {
      const body = init?.body ? (JSON.parse(String(init.body)) as { kind?: string }) : {};
      if (body.kind) kinds.push(body.kind);
      return response({ ok: true });
    }) as typeof fetch;
    const reporter = new ExecutionLeaseReporter(context, { fetchFn, heartbeatIntervalMs: 60_000 });
    reporter.markBusy('root');
    reporter.markBusy('child');
    reporter.markInactive('root');
    await reporter.settled();
    expect(kinds).toEqual(['execution_heartbeat']);
    reporter.markInactive('child');
    await reporter.settled();
    expect(kinds).toEqual(['execution_heartbeat', 'execution_lease_release']);
  });
});
