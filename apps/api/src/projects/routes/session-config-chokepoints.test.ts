/**
 * `GET /v1/projects/:projectId/sessions/:sessionId/config` had no unit test of
 * its own. Its handler is a `projectsApp.openapi(...)` registration with no
 * per-route export, and standing the app up pulls in the whole API and a live
 * database — the constraint `r3-secret-policy-authz.test.ts` documents. So
 * these assertions are on the handler SOURCE, scoped per route, and they check
 * ORDERING.
 *
 * End-to-end HTTP proof lives in `tests/src/flows/config-releases.flow.ts`
 * (CFG-6, CFG-7, CFG-4).
 */
import { describe, expect, test } from 'bun:test';

const SRC = await Bun.file(new URL('./session-config.ts', import.meta.url).pathname).text();

function handlerSource(method: string, path: string): string {
  const blocks = SRC.split('projectsApp.openapi(');
  const match = blocks.find((b) => b.includes(`method: '${method}'`) && b.includes(`path: '${path}'`));
  if (!match) throw new Error(`no ${method.toUpperCase()} ${path} handler found in session-config.ts`);
  return match;
}

const CONFIG = handlerSource('get', '/{projectId}/sessions/{sessionId}/config');
const RELOAD = handlerSource('post', '/{projectId}/sessions/{sessionId}/reload');

describe('GET /config authorizes before it reads session state', () => {
  test('it asserts the session-read leaf, not only the coarse access level', () => {
    const load = CONFIG.indexOf("loadProjectForUser(c, projectId, 'session')");
    const leaf = CONFIG.indexOf('PROJECT_ACTIONS.PROJECT_SESSION_READ');
    const read = CONFIG.indexOf('readSandboxConfigState(');
    expect(load).toBeGreaterThan(-1);
    expect(leaf).toBeGreaterThan(load);
    expect(read).toBeGreaterThan(leaf);
  });

  test('the flag is the chokepoint for the release block', () => {
    expect(CONFIG).toContain('const releasesEnabled = configReleasesEnabled(loaded.row.metadata)');
    expect(CONFIG.indexOf('const releasesEnabled')).toBeLessThan(CONFIG.indexOf('resolveDesiredRelease('));
    expect(CONFIG).toContain('if (releasesEnabled && running.configReleases && running.release)');
  });
});

describe('every session is compared the same way', () => {
  // The `stale: false` / `latest_etag: null` early return for a session from a
  // previous repository generation was deleted on 2026-09-24. Such a session
  // now reports `stale` by the ordinary release-ID compare, which can be true.
  test('the repository generation decides nothing on this route', () => {
    expect(SRC).not.toContain('sessionUsesCurrentRepository');
    expect(SRC).not.toContain('usesCurrentRepository');
  });

  test('stale is the release-ID compare, tri-state, never a default false', () => {
    expect(CONFIG).toContain('stale: isReleaseStale(release, desired !== null)');
  });

  test('the compiled etag is read for every session', () => {
    // It used to be skipped for a "frozen" session, which forced `latest_etag`
    // to null and made the pre-release compare unusable for it.
    expect(CONFIG).toContain('latestAgentConfigEtag({');
    expect(CONFIG).not.toContain('Promise.resolve(null)');
  });
});

describe('the read decides the agent re-point exactly as the assignment does', () => {
  test('it asks the same IAM question about the same subject', () => {
    expect(CONFIG).toContain('ownerMayUseAgent: (agent) => ownerMayUseAgent(repointSubject, agent)');
    expect(CONFIG).toContain('ownerUserId: visible.row.createdBy ?? null');
  });

  test('a read NEVER writes: no persistRepoint, no assignment record', () => {
    expect(CONFIG).not.toContain('persistRepoint');
    expect(CONFIG).not.toContain('recordAssignment');
  });

  test('it surfaces agent_repoint so the header and the CLI can say why', () => {
    expect(CONFIG).toContain('desired?.descriptor.agent_repoint');
    expect(CONFIG).toContain('agent_repoint: desired.descriptor.agent_repoint');
  });
});

describe('the managed-model catalog is visible on GET /config regardless of releases', () => {
  // 2026-09-26: a stale box's catalog was invisible everywhere except a daemon
  // log line. `managed_catalog` closes that — computed ONCE, spread into BOTH
  // branches, so a project with config releases off still sees it.
  test('computed once, before the releases-flag branch, from the same read', () => {
    const computed = CONFIG.indexOf('const managedCatalog = {');
    const read = CONFIG.indexOf('readSandboxConfigState(');
    const releasesBranch = CONFIG.indexOf(
      'if (releasesEnabled && running.configReleases && running.release)',
    );
    expect(computed).toBeGreaterThan(read);
    expect(computed).toBeLessThan(releasesBranch);
    expect(CONFIG).toContain('running.runtime?.running?.managed_model_ids');
    expect(CONFIG).toContain('running.runtime?.running?.managed_catalog_fallback_reason');
  });

  test('both response branches carry it — the release path and the pre-release path', () => {
    const occurrences = CONFIG.split('managed_catalog: managedCatalog').length - 1;
    expect(occurrences).toBe(2);
  });
});

describe('the reload route still protects a running turn', () => {
  test('a mid-turn reload is refused 409 SESSION_BUSY unless forced', () => {
    expect(RELOAD).toContain("result.reason === 'session is mid-turn'");
    expect(RELOAD).toContain("result.reason === 'could not confirm the session is idle'");
    expect(RELOAD).toContain("code: 'SESSION_BUSY'");
    // `readJsonObject` (shared/http-body.ts, main #7650) never returns null,
    // so the route reads `body.force` without the optional chain.
    expect(RELOAD).toContain('force: body.force === true');
  });

  test('seeing a session is not permission to restart its runtime', () => {
    const gate = RELOAD.indexOf('mayChangeSessionModel(visible)');
    const reload = RELOAD.indexOf('reloadSessionConfig({');
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(reload);
  });
});
