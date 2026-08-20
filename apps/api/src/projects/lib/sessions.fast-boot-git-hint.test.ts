import { describe, expect, test } from 'bun:test';

async function sessionsSource(): Promise<string> {
  return Bun.file(new URL('./sessions.ts', import.meta.url)).text();
}

describe('session fast boot Git hint cache', () => {
  test('resolves a validated cache entry through the authenticated project', async () => {
    const source = await sessionsSource();
    const authPromise = source.indexOf('const projectWithGitAuthPromise');
    const gate = source.indexOf('config.KORTIX_FAST_COLD_BOOT_ENABLED', authPromise);
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
    const gate = source.indexOf('config.KORTIX_FAST_COLD_BOOT_ENABLED');
    const provision = source.indexOf('provisionSessionSandbox({', gate);
    const fastBootBlock = source.slice(gate, provision);
    expect(fastBootBlock).toContain('setTimeout(() => resolve(undefined), 2_000)');
    expect(fastBootBlock).toContain('clearTimeout(fastBootHintTimeout)');
    expect(fastBootBlock).toContain(': Promise.resolve(undefined)');
  });
});
