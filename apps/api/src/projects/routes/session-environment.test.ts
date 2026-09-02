import { describe, expect, test } from 'bun:test';

async function routeSource(): Promise<string> {
  return Bun.file(new URL('./session-environment.ts', import.meta.url)).text();
}

async function serviceSource(): Promise<string> {
  return Bun.file(
    new URL('../../platform/services/session-environment.ts', import.meta.url),
  ).text();
}
async function typesSource(): Promise<string> {
  return Bun.file(
    new URL('../../platform/services/session-environment-types.ts', import.meta.url),
  ).text();
}
async function teardownSource(): Promise<string> {
  return Bun.file(
    new URL('../../platform/services/session-environment-teardown.ts', import.meta.url),
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
    // The shape itself lives in `session-environment-types.ts` — a module with
    // no imports, so the teardown half can name it without importing the
    // provisioning half.
    const types = await typesSource();
    const info = types.indexOf('export interface SessionEnvironmentInfo');
    const infoBlock = types.slice(info, types.indexOf('}', info));
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

async function orphanReaperSource(): Promise<string> {
  return Bun.file(new URL('../reaping/orphan-boxes.ts', import.meta.url)).text();
}
async function stopSource(): Promise<string> {
  return Bun.file(new URL('../session-lifecycle/stop.ts', import.meta.url)).text();
}
async function deleteSource(): Promise<string> {
  return Bun.file(new URL('../session-lifecycle/actions.ts', import.meta.url)).text();
}

describe('an environment does not outlive the session that owns it', () => {
  test('stopping a session stops its environment box', async () => {
    const source = await stopSource();
    // Otherwise the compute box runs on nothing but the provider idle timer.
    expect(source).toContain('stopSessionEnvironment(sessionId)');
    // After the fact and best-effort: the session is already stopped, so a
    // provider hiccup must not turn a successful stop into a 502.
    expect(source).toContain('[session-stop] environment stop failed');
  });

  test('deleting a session deletes its environment box AND row', async () => {
    const source = await deleteSource();
    // Sessions are SOFT-deleted (metadata.deletedAt), so nothing cascades.
    expect(source).toContain('deleteSessionEnvironment(sessionId)');
  });

  test('the orphan reaper keeps live environments — it used to stop them at ~1h', async () => {
    const source = await orphanReaperSource();
    // An environment has its own table and no session_sandboxes row, exactly
    // like a monitor box. Missing from the keepSet, this sweep stopped the
    // compute box under a live session and nothing recovered: `ensure` only
    // resumes a row whose status reads 'stopped', and the reaper never writes
    // that column.
    expect(source).toContain('.from(sessionEnvironments)');
    expect(source).toContain('...environmentKeepRows');
    expect(source).toContain('sessionEnvironments.lastUsedAt');
  });
});

describe('an environment meters against its PARENT session', () => {
  // An environment has no session_sandboxes row — the table every billing join
  // keys on — so before this its compute was metered NOWHERE, and a pi
  // session's cost went invisible the moment the work moved into the second
  // box. Metered as part of the parent session (not as its own line), so the
  // seconds and cost roll into that session's existing figure.
  test('the compute window carries the parent session id, not the box id', async () => {
    const source = await serviceSource();
    // Anchor on the METER call: `sandboxId: environmentId` also appears in
    // `provider.create` above it, and it is the resume call that comes first
    // in the file.
    const call = source.slice(
      source.indexOf('await startComputeSession({\n      sandboxId: environmentId'),
    );
    expect(call.slice(0, 300)).toContain('sandboxId: environmentId');
    // THE decision: attribution follows the session, not the environment.
    expect(call.slice(0, 300)).toContain('sessionId: input.sessionId');
  });

  test('the window closes with the box, on stop and on delete', async () => {
    // Teardown moved to its own module so the maintenance reaper can import it
    // without dragging the provisioning graph (image builder, git, agent-config
    // compiler) along. The assertion follows the code.
    const source = await teardownSource();
    const stop = source.slice(source.indexOf('export async function stopSessionEnvironment'));
    const del = source.slice(source.indexOf('export async function deleteSessionEnvironment'));
    expect(stop.slice(0, 2000)).toContain('endComputeSession(meteredId)');
    expect(del.slice(0, 700)).toContain('endComputeSession(meteredId)');
  });

  test('a resumed environment opens a NEW window — the old one closed on stop', async () => {
    const source = await serviceSource();
    const resume = source.slice(source.indexOf('await resumeEnvironment(externalId)'));
    expect(resume.slice(0, 900)).toContain('startComputeSession({');
    expect(resume.slice(0, 900)).toContain('sessionId: input.sessionId');
  });

  test('metering keys off environmentId, never the provider externalId', async () => {
    const source = await serviceSource();
    // They are different values: `environmentId` is the id we minted and
    // passed to provider.create as its sandboxId; `externalId` is what the
    // provider handed back. `endComputeSession` looks up by the former.
    expect(source).toContain("metadata as { environmentId?: string }");
  });
});
