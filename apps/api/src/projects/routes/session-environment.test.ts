import { describe, expect, test } from 'bun:test';

async function routeSource(): Promise<string> {
  return Bun.file(new URL('./session-environment.ts', import.meta.url)).text();
}

async function serviceSource(): Promise<string> {
  return Bun.file(
    new URL('../../platform/services/session-environment.ts', import.meta.url),
  ).text();
}

// The environment routes cannot be flow-covered locally (they provision a
// REAL cloud sandbox, which the local flow profile excludes), so their
// contract is pinned at source level — referenced by the coverage allowlist.
describe('session environment routes', () => {
  test('a session-scoped caller may only address its OWN environment, before any capability check', async () => {
    const source = await routeSource();
    const gate = source.indexOf('async function authorizeEnvironmentCall');
    const load = source.indexOf('loadProjectForUser(c, projectId', gate);
    const selfScope = source.indexOf('callerSession !== sessionId', gate);
    const capability = source.indexOf('assertProjectCapability(', gate);
    expect(gate).toBeGreaterThan(-1);
    expect(load).toBeGreaterThan(gate);
    expect(selfScope).toBeGreaterThan(load);
    expect(capability).toBeGreaterThan(selfScope);
    // Humans need the capability; the session's own token does not re-check it.
    expect(source.slice(gate, capability)).toContain('if (!callerSession)');
  });

  test('ensure refuses non-pi sessions and every handler passes the shared gate', async () => {
    const source = await routeSource();
    const ensure = source.indexOf("path: '/{projectId}/sessions/{sessionId}/environment/ensure'");
    const slugGate = source.indexOf("sandbox_slug !== 'pi-worker'", ensure);
    const call = source.indexOf('ensureSessionEnvironment({', ensure);
    expect(ensure).toBeGreaterThan(-1);
    expect(slugGate).toBeGreaterThan(ensure);
    expect(slugGate).toBeLessThan(call);
    // All three routes run the same authorization.
    const occurrences = source.split('authorizeEnvironmentCall(c,').length - 1;
    expect(occurrences).toBe(3);
  });
});

describe('session environment service', () => {
  test('the environment boots as THE SESSION: its token is the session service key, opencode off', async () => {
    const source = await serviceSource();
    const provision = source.indexOf('const provider = getProvider');
    expect(source.indexOf('sessionServiceKey(input.sessionId)')).toBeGreaterThan(-1);
    const envBlock = source.slice(provision, source.indexOf('} as never', provision));
    expect(envBlock).toContain('KORTIX_TOKEN: token');
    expect(envBlock).toContain("KORTIX_BOOTSTRAP_OPENCODE_SESSION: '0'");
    // The session branch already exists remotely; the box restores it.
    expect(source).toContain('restoreSessionBranch: true');
  });

  test('the claim is an ON CONFLICT insert and every terminal failure marks the row error', async () => {
    const source = await serviceSource();
    expect(source.indexOf('.onConflictDoNothing()')).toBeGreaterThan(-1);
    // Failure marking is what enables the error -> provisioning re-claim, and
    // with the work detached from the request the row is the ONLY channel it
    // has: `provisionEnvironment` swallows nothing silently.
    expect(source).toContain("status: 'error'");
    expect(source).toContain('markEnvironmentError(input.sessionId, err)');
    // 'error' is a re-claimable state, which is what makes the retry work.
    expect(source).toContain("existing.status !== 'error'");
  });

  test('ensure never waits for the provision — the request would be killed at 25s', async () => {
    const source = await serviceSource();
    const fn = source.indexOf('export async function ensureSessionEnvironment');
    const body = source.slice(fn, source.indexOf('\n}', fn));
    // The work is started, not awaited. Awaiting it is the bug this replaced:
    // every first compute tool call 503'd until the worker's budget expired.
    expect(body).toContain('void runEnvironmentWork(');
    expect(body).not.toContain('await runEnvironmentWork(');
    expect(body).not.toContain('await provisionEnvironment(');
    // The loser of the claim reports status instead of polling for the winner.
    expect(body).toContain('return withPreview(row)');
    expect(source).not.toContain('CLAIM_WAIT_MS');
  });

  test('a provision whose owner died is re-claimable, so a crash cannot wedge a session', async () => {
    const source = await serviceSource();
    // Nothing else ever re-claims a 'provisioning' row: without this the
    // session's environment stays stuck at 'provisioning' forever.
    expect(source).toContain('PROVISION_STALE_MS');
    const claim = source.indexOf('async function claimEnvironmentWork');
    const block = source.slice(claim, source.indexOf('\n}', claim));
    expect(block).toContain("existing.status === 'provisioning'");
    expect(block).toContain('abandoned');
    // The re-claim is conditioned on the status that was read, so two racing
    // callers cannot both win it.
    expect(block).toContain('eq(sessionEnvironments.status, existing.status)');
  });

  test('the worker reaches the environment over the provider edge, not the session proxy', async () => {
    const source = await serviceSource();
    expect(source).toContain('getPreviewLink(8000)');
    expect(source).toContain('previewToken');
    // No /p/:externalId proxy URL is handed to the worker as the data path.
    const info = source.indexOf('export interface SessionEnvironmentInfo');
    const infoBlock = source.slice(info, source.indexOf('}', info));
    expect(infoBlock).toContain('previewUrl');
  });
});

describe('session environment lifecycle bounds', () => {
  test('an environment box carries a tight idle auto-stop, never the 12h backstop', async () => {
    const source = await serviceSource();
    const create = source.indexOf('provider.create({');
    const block = source.slice(create, source.indexOf('} as never', create));
    expect(block).toContain('autoStopInterval: 60');
  });
});
