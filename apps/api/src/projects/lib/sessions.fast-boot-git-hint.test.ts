import { describe, expect, test } from 'bun:test';

async function sessionsSource(): Promise<string> {
  return Bun.file(new URL('./sessions.ts', import.meta.url)).text();
}

async function monitorBoxProvisionSource(): Promise<string> {
  return Bun.file(new URL('./monitor-box-provision.ts', import.meta.url)).text();
}

describe('session fast boot Git hint cache', () => {
  test('resolves a validated cache entry through the authenticated project', async () => {
    const source = await sessionsSource();
    const authPromise = source.indexOf('const projectWithGitAuthPromise');
    const gate = source.indexOf('config.KORTIX_FAST_GIT_BOOT_ENABLED', authPromise);
    const resolver = source.indexOf('resolveFastBootGitHintWithCache(', gate);
    const provision = source.indexOf('provisionSessionSandbox({', resolver);
    expect(authPromise).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(authPromise);
    expect(resolver).toBeGreaterThan(gate);
    expect(provision).toBeGreaterThan(resolver);
    expect(source.slice(gate, provision)).toContain('projectWithGitAuthPromise');
    expect(source.slice(resolver, provision)).toContain('project.metadata');
  });

  test('keeps the cache lookup inside the existing two-second boot deadline', async () => {
    const source = await sessionsSource();
    const gate = source.indexOf('config.KORTIX_FAST_GIT_BOOT_ENABLED');
    const provision = source.indexOf('provisionSessionSandbox({', gate);
    const fastBootBlock = source.slice(gate, provision);
    expect(fastBootBlock).toContain('setTimeout(() => resolve(undefined), 2_000)');
    expect(fastBootBlock).toContain('clearTimeout(fastBootHintTimeout)');
    expect(fastBootBlock).toContain(': Promise.resolve(undefined)');
  });

  test('gates every session allocation before a full-repository image can be selected', async () => {
    const [sessions, allocator, actions, shared, sandbox] = await Promise.all([
      sessionsSource(),
      Bun.file(new URL('./session-runtime-allocator.ts', import.meta.url)).text(),
      Bun.file(new URL('../session-lifecycle/actions.ts', import.meta.url)).text(),
      Bun.file(new URL('../routes/shared.ts', import.meta.url)).text(),
      Bun.file(new URL('../../platform/services/session-sandbox.ts', import.meta.url)).text(),
    ]);

    // The pi worker boot (harness/worker split) wraps the gate in a ternary:
    // a pi session never receives a project image, every other session still
    // goes through projectImageAllowedForSession. Both halves are pinned.
    expect(sessions).toContain('allowProjectImage: piWorkerBoot');
    expect(sessions).toContain(': projectImageAllowedForSession(agentName, workspaceMode)');
    expect(actions).toContain('allowProjectImage: projectImageAllowedForSession(');
    expect(shared).toContain('allowProjectImage: projectImageAllowedForSession(');
    expect(actions).toContain('restoreSessionBranch: true');
    expect(shared).toContain('restoreSessionBranch: true');
    expect(allocator).toContain('allowProjectImage: input.allowProjectImage');
    expect(sandbox).toContain('allowProjectImage: opts.allowProjectImage');
  });

  test('keeps persistent monitor boxes on the shared image', async () => {
    const source = await monitorBoxProvisionSource();
    const ensureCall = source.slice(
      source.indexOf('ensureSandboxImage(gitProject'),
      source.indexOf('});', source.indexOf('ensureSandboxImage(gitProject')),
    );

    expect(ensureCall).toContain('allowProjectImage: false');
  });
});
