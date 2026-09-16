import { describe, expect, test } from 'bun:test';

import { PROJECT_ACTIONS } from '../../iam/actions';
import {
  environmentSandboxSlugFromSessionMetadata,
  piWorkerRuntimeIdentityFromSessionMetadata,
  piWorkerSandboxProviderMatches,
  projectImageAllowedForSession,
  resolveSessionSandboxSlug,
  sandboxSlugFromSessionMetadata,
  sanitizeCallerSessionMetadata,
  sessionMetadataClaimsPiWorker,
  repositoryAccessFromSessionMetadata,
} from './session-sandbox-metadata';
import {
  isRepositoryProjectAction,
  workspaceMetadataAllowsRepositoryAccess,
} from './session-workspace-access';

describe('sandboxSlugFromSessionMetadata', () => {
  test('returns a persisted template slug', () => {
    expect(sandboxSlugFromSessionMetadata({ sandbox_slug: 'ml' })).toBe('ml');
    expect(sandboxSlugFromSessionMetadata({ sandbox_slug: 'default' })).toBe('default');
  });

  test('rejects missing and invalid metadata values', () => {
    expect(sandboxSlugFromSessionMetadata(null)).toBeUndefined();
    expect(sandboxSlugFromSessionMetadata({})).toBeUndefined();
    expect(sandboxSlugFromSessionMetadata({ sandbox_slug: '../escape' })).toBeUndefined();
  });
});

describe('environmentSandboxSlugFromSessionMetadata', () => {
  test('returns the compute template selected before the Pi worker replaces the runtime slug', () => {
    expect(
      environmentSandboxSlugFromSessionMetadata({ environment_sandbox_slug: 'gpu-large' }),
    ).toBe('gpu-large');
  });

  test('rejects missing and invalid compute template slugs', () => {
    expect(environmentSandboxSlugFromSessionMetadata(null)).toBeUndefined();
    expect(environmentSandboxSlugFromSessionMetadata({})).toBeUndefined();
    expect(
      environmentSandboxSlugFromSessionMetadata({ environment_sandbox_slug: '../escape' }),
    ).toBeUndefined();
  });
});

describe('Pi worker runtime identity metadata', () => {
  test('pins the v0 worker to its supported provider', () => {
    expect(piWorkerSandboxProviderMatches('daytona')).toBe(true);
    expect(piWorkerSandboxProviderMatches('platinum')).toBe(false);
    expect(piWorkerSandboxProviderMatches('e2b')).toBe(false);
  });

  test('reads only a complete server-owned immutable identity', () => {
    expect(
      piWorkerRuntimeIdentityFromSessionMetadata({
        sandbox_slug: 'pi-worker',
        pi_worker_boot: true,
        pi_worker_ref: 'main',
        pi_worker_sha: 'a'.repeat(40),
      }),
    ).toEqual({ ref: 'main', sha: 'a'.repeat(40) });

    expect(
      piWorkerRuntimeIdentityFromSessionMetadata({
        sandbox_slug: 'pi-worker',
        pi_worker_boot: true,
        pi_worker_ref: 'main',
      }),
    ).toBeNull();
    expect(
      piWorkerRuntimeIdentityFromSessionMetadata({
        sandbox_slug: 'default',
        pi_worker_boot: true,
        pi_worker_ref: 'main',
        pi_worker_sha: 'a'.repeat(40),
      }),
    ).toBeNull();
    expect(
      piWorkerRuntimeIdentityFromSessionMetadata({
        sandbox_slug: 'pi-worker',
        pi_worker_boot: true,
        pi_worker_ref: 'main',
        pi_worker_sha: 'not-a-commit',
      }),
    ).toBeNull();
    expect(sessionMetadataClaimsPiWorker({ sandbox_slug: 'pi-worker' })).toBe(true);
    expect(sessionMetadataClaimsPiWorker({ pi_worker_boot: true })).toBe(true);
    expect(
      sessionMetadataClaimsPiWorker({ runtimeArtifact: { runtimeProfile: 'pi-worker' } }),
    ).toBe(true);
    expect(sessionMetadataClaimsPiWorker({ pi_worker_ref: 'main' })).toBe(true);
    expect(sessionMetadataClaimsPiWorker({ sandbox_slug: 'default' })).toBe(false);
  });

  test('removes every server-owned Pi identity field from caller metadata', () => {
    expect(
      sanitizeCallerSessionMetadata({
        source: 'internal:test',
        sandbox_slug: 'pi-worker',
        pi_worker_boot: true,
        pi_worker_ref: 'forged-ref',
        pi_worker_sha: 'b'.repeat(40),
        environment_sandbox_slug: 'forged-template',
        runtimeArtifact: { runtimeProfile: 'pi-worker' },
      }),
    ).toEqual({ source: 'internal:test' });
  });
});

describe('repositoryAccessFromSessionMetadata', () => {
  test('returns a persisted workspace mode', () => {
    expect(repositoryAccessFromSessionMetadata({ workspace_mode: 'runtime' })).toBe(false);
    expect(repositoryAccessFromSessionMetadata({ workspace_mode: 'read' })).toBe(false);
    expect(repositoryAccessFromSessionMetadata({ workspace_mode: 'branch' })).toBe(true);
  });

  test('keeps missing metadata legacy-compatible and maps invalid stored modes to runtime', () => {
    expect(repositoryAccessFromSessionMetadata(null)).toBe(true);
    expect(repositoryAccessFromSessionMetadata({})).toBe(true);
    expect(repositoryAccessFromSessionMetadata({ workspace_mode: 'all' })).toBe(false);
    expect(repositoryAccessFromSessionMetadata({ workspace_mode: null })).toBe(false);
  });
});

describe('restricted workspace repository boundary', () => {
  test('restricted metadata denies repository access while branch and legacy metadata allow it', () => {
    expect(workspaceMetadataAllowsRepositoryAccess({ workspace_mode: 'runtime' })).toBe(false);
    expect(workspaceMetadataAllowsRepositoryAccess({ workspace_mode: 'read' })).toBe(false);
    expect(workspaceMetadataAllowsRepositoryAccess({ workspace_mode: 'all' })).toBe(false);
    expect(workspaceMetadataAllowsRepositoryAccess({ workspace_mode: 'branch' })).toBe(true);
    expect(workspaceMetadataAllowsRepositoryAccess({})).toBe(true);
  });

  test('project images require a full-repository non-meta session', () => {
    expect(projectImageAllowedForSession('default', true)).toBe(true);
    expect(projectImageAllowedForSession('default', undefined)).toBe(true);
    expect(projectImageAllowedForSession('default', false)).toBe(false);
    expect(projectImageAllowedForSession('default', false)).toBe(false);
    expect(projectImageAllowedForSession('meta', true)).toBe(false);
  });

  test('classifies every repository-backed project capability', () => {
    expect(isRepositoryProjectAction(PROJECT_ACTIONS.PROJECT_FILE_READ)).toBe(true);
    expect(isRepositoryProjectAction(PROJECT_ACTIONS.PROJECT_FILE_WRITE)).toBe(true);
    expect(isRepositoryProjectAction(PROJECT_ACTIONS.PROJECT_GITOPS_READ)).toBe(true);
    expect(isRepositoryProjectAction(PROJECT_ACTIONS.PROJECT_GITOPS_PUSH)).toBe(true);
    expect(isRepositoryProjectAction(PROJECT_ACTIONS.PROJECT_GITOPS_MERGE)).toBe(true);
    expect(isRepositoryProjectAction(PROJECT_ACTIONS.PROJECT_SECRET_READ)).toBe(false);
    expect(isRepositoryProjectAction(PROJECT_ACTIONS.PROJECT_CONNECTOR_READ)).toBe(false);
  });
});

describe('resolveSessionSandboxSlug', () => {
  test('uses explicit, agent, project, then platform precedence', () => {
    expect(
      resolveSessionSandboxSlug({
        explicit: 'override',
        agent: 'ml',
        project: 'node',
      }),
    ).toBe('override');
    expect(resolveSessionSandboxSlug({ agent: 'ml', project: 'node' })).toBe('ml');
    expect(resolveSessionSandboxSlug({ project: 'node' })).toBe('node');
    expect(resolveSessionSandboxSlug({})).toBe('default');
  });
});


describe('repository_access session metadata', () => {
  test('honors the canonical restriction without legacy metadata', () => {
    expect(workspaceMetadataAllowsRepositoryAccess({ repository_access: false })).toBe(false);
    expect(workspaceMetadataAllowsRepositoryAccess({ repository_access: true })).toBe(true);
  });
  test('invalid canonical values and conflicting restrictions fail closed', () => {
    for (const value of [null, 'true', 1, {}]) {
      expect(workspaceMetadataAllowsRepositoryAccess({ repository_access: value })).toBe(false);
    }
    expect(workspaceMetadataAllowsRepositoryAccess({ repository_access: true, workspace_mode: 'runtime' })).toBe(false);
    expect(workspaceMetadataAllowsRepositoryAccess({ repository_access: false, workspace_mode: 'branch' })).toBe(false);
  });
});
