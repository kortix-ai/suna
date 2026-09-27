/**
 * The two config-release routes had no unit test of their own. Their handlers
 * are `projectsApp.openapi(...)` registrations with no per-route export, and
 * standing the app up pulls in the whole API and a live database — the same
 * constraint `r3-secret-policy-authz.test.ts` and `r4-question-authz.test.ts`
 * document. So these assertions are on the handler SOURCE, scoped per route,
 * and they check ORDERING: a gate that runs after the thing it protects is not
 * a gate.
 *
 * End-to-end HTTP proof lives in `tests/src/flows/config-releases.flow.ts`
 * (CFG-1, CFG-2, CFG-4, CFG-7).
 */
import { describe, expect, test } from 'bun:test';

const SRC = await Bun.file(new URL('../routes.ts', import.meta.url).pathname).text();

/** One `projectsApp.openapi(...)` registration, selected by method and path. */
function handlerSource(method: string, path: string): string {
  const blocks = SRC.split('projectsApp.openapi(');
  const match = blocks.find((b) => b.includes(`method: '${method}'`) && b.includes(`path: '${path}'`));
  if (!match) throw new Error(`no ${method.toUpperCase()} ${path} handler found in config-releases/routes.ts`);
  return match;
}

const DESCRIPTOR = handlerSource('post', '/{projectId}/sessions/{sessionId}/config-release');
const ARCHIVE = handlerSource('get', '/{projectId}/config-archives/{configTreeId}');

describe('the feature flag is the chokepoint of both routes', () => {
  test('each route gates on the flag', () => {
    expect(DESCRIPTOR).toContain('configReleasesGate(c, project)');
    expect(ARCHIVE).toContain('configReleasesGate(c, project)');
  });

  test('the descriptor route gates AFTER authz, so a non-member learns nothing', () => {
    const authz = DESCRIPTOR.indexOf('PROJECT_ACTIONS.PROJECT_SESSION_READ');
    const gate = DESCRIPTOR.indexOf('configReleasesGate(c, project)');
    expect(authz).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(authz);
  });

  test('the flag is read BEFORE any release is built or archive is served', () => {
    expect(DESCRIPTOR.indexOf('configReleasesGate(c, project)')).toBeLessThan(
      DESCRIPTOR.indexOf('resolveDesiredRelease('),
    );
    expect(ARCHIVE.indexOf('configReleasesGate(c, project)')).toBeLessThan(
      ARCHIVE.indexOf('serveConfigArchive('),
    );
  });
});

describe('a session from a previous repository generation is NOT refused', () => {
  // The whole policy was deleted on 2026-09-24. A release is the project's
  // CURRENT config; it never touches a session's /workspace clone. What is
  // left is physical: that clone and the new origin hold unrelated histories.
  test('neither route carries the repository-generation refusal any more', () => {
    for (const source of [SRC, DESCRIPTOR, ARCHIVE]) {
      expect(source).not.toContain('session_repository_changed');
      expect(source).not.toContain('PREVIOUS_REPOSITORY_BODY');
      expect(source).not.toContain('sessionUsesCurrentRepository');
    }
  });

  test('the archive route still refuses a session without repository access', () => {
    expect(ARCHIVE).toContain('repositoryAccessFromSessionMetadata');
    expect(ARCHIVE).toContain("'repository access withheld'");
    expect(ARCHIVE.indexOf("'repository access withheld'")).toBeLessThan(
      ARCHIVE.indexOf('serveConfigArchive('),
    );
  });
});

describe('the agent re-point is persisted by the daemon alone', () => {
  test('the descriptor route is the ONE call site of the column writer', () => {
    expect(DESCRIPTOR).toContain('repointSessionAgentToDeclaredDefault(subject, from, to)');
    // Exactly one invocation in this file. The repo-wide tripwire that it is
    // the only one anywhere lives in `repoint.test.ts`.
    expect(SRC.split('repointSessionAgentToDeclaredDefault(').length - 1).toBe(1);
  });

  test('only a sandbox credential may persist it; a human read decides without writing', () => {
    expect(DESCRIPTOR).toContain('const isDaemon = isSessionSandboxCredential(c)');
    expect(DESCRIPTOR).toContain('...(isDaemon');
    expect(DESCRIPTOR).toContain('persistRepoint:');
    // `ownerMayUseAgent` is passed unconditionally: the read must decide the
    // same way the assignment does, or `stale` disagrees between them.
    const persist = DESCRIPTOR.indexOf('persistRepoint:');
    const may = DESCRIPTOR.indexOf('ownerMayUseAgent: (agent)');
    expect(may).toBeGreaterThan(-1);
    expect(may).toBeLessThan(persist);
  });

  test('the authorization subject is the session OWNER, not the caller', () => {
    // The caller on this path is the sandbox's own credential, which carries
    // no IAM identity (`Credential.kind === 'sandbox'`).
    expect(DESCRIPTOR).toContain('ownerUserId: session.createdBy');
  });

  test('the assignment is recorded only for the daemon', () => {
    expect(DESCRIPTOR).toContain('recordAssignment: isDaemon');
  });
});

describe('the descriptor has no inputs', () => {
  test('the handler reads no request body', () => {
    expect(DESCRIPTOR).not.toContain('readBody(');
    expect(DESCRIPTOR).not.toContain('c.req.json(');
  });

  test('the base ref comes from the session row, never from the caller', () => {
    expect(DESCRIPTOR).toContain('const baseRef = session.baseRef ?? project.defaultBranch');
  });
});
