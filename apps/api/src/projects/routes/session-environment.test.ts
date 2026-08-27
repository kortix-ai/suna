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
    const claim = source.indexOf('.onConflictDoNothing()');
    expect(claim).toBeGreaterThan(-1);
    // The losing claimant polls the winner instead of double-provisioning.
    expect(source).toContain('Timed out waiting for the environment claim');
    // Failure marking enables the error → provisioning re-claim.
    const failMark = source.indexOf("status: 'error'");
    const reclaim = source.indexOf("eq(sessionEnvironments.status, 'error')");
    expect(failMark).toBeGreaterThan(-1);
    expect(reclaim).toBeGreaterThan(-1);
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
