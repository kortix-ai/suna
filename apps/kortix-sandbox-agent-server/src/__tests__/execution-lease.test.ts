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
  test('stays silent while idle, then acquires, renews, and releases while busy', async () => {
    const calls: Array<{ url: string; action?: string; headers?: RequestInit['headers'] }> = [];
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? (JSON.parse(String(init.body)) as { action?: string }) : {};
      calls.push({ url, action: body.action, headers: init?.headers });
      return url.startsWith('https://api.test/')
        ? response({
            provider_url: 'https://edge.test',
            provider_headers: { 'X-Daytona-Preview-Token': 'preview-secret', Authorization: 'drop-me' },
          })
        : response({ status: 'ok' });
    }) as typeof fetch;
    const reporter = new ExecutionLeaseReporter(context, { fetchFn, heartbeatIntervalMs: 5 });
    await reporter.settled();
    expect(calls).toEqual([]);
    reporter.markBusy('root');
    await reporter.settled();
    await Bun.sleep(12);
    reporter.markInactive('root');
    await reporter.settled();
    expect(calls.some((call) => call.url.endsWith('/execution-lease'))).toBe(true);
    expect(calls.some((call) => call.action === 'acquire')).toBe(true);
    expect(calls.some((call) => call.action === 'renew')).toBe(true);
    expect(calls.some((call) => call.action === 'release')).toBe(true);
    const direct = calls.find((call) => call.url === 'https://edge.test/kortix/health');
    expect(direct).toBeDefined();
    expect(direct?.headers).toMatchObject({
      'X-Daytona-Preview-Token': 'preview-secret',
      Authorization: 'Bearer kortix_sb_test',
    });
  });
  test('holds the lease until every root/subagent is inactive', async () => {
    const actions: string[] = [];
    const fetchFn = (async (_input: string | URL | Request, init?: RequestInit) => {
      const body = init?.body ? (JSON.parse(String(init.body)) as { action?: string }) : {};
      if (body.action) actions.push(body.action);
      return response({ ok: true });
    }) as typeof fetch;
    const reporter = new ExecutionLeaseReporter(context, { fetchFn, heartbeatIntervalMs: 60_000 });
    reporter.markBusy('root');
    reporter.markBusy('child');
    reporter.markInactive('root');
    await reporter.settled();
    expect(actions).toEqual(['acquire']);
    reporter.markInactive('child');
    await reporter.settled();
    expect(actions).toEqual(['acquire', 'release']);
  });

  test('coalesces timer renewals while one renewal is pending', async () => {
    const actions: string[] = [];
    let releaseRenewal!: () => void;
    const renewalBlocked = new Promise<void>((resolve) => {
      releaseRenewal = resolve;
    });
    const fetchFn = (async (_input: string | URL | Request, init?: RequestInit) => {
      const body = init?.body ? (JSON.parse(String(init.body)) as { action?: string }) : {};
      if (body.action) actions.push(body.action);
      if (body.action === 'renew') await renewalBlocked;
      return response({ ok: true });
    }) as typeof fetch;
    const reporter = new ExecutionLeaseReporter(context, { fetchFn, heartbeatIntervalMs: 5 });
    reporter.markBusy('root');
    await reporter.settled();
    await Bun.sleep(18);
    reporter.markInactive('root');
    releaseRenewal();
    await reporter.settled();
    expect(actions.filter((action) => action === 'renew')).toHaveLength(1);
    expect(actions.at(-1)).toBe('release');
  });
});
