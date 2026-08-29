import { describe, expect, test } from 'bun:test';
import { normalizePiAgentName } from './compiled-pi-runtime-artifact';

async function artifactSource(): Promise<string> {
  return Bun.file(new URL('./compiled-pi-runtime-artifact.ts', import.meta.url)).text();
}
async function routeSource(): Promise<string> {
  return Bun.file(new URL('./index.ts', import.meta.url)).text();
}
async function prebuildSource(): Promise<string> {
  return Bun.file(new URL('./compiled-prebuild.ts', import.meta.url)).text();
}

describe('normalizePiAgentName', () => {
  // The name reaches a cache FILENAME and the baked config, so it is validated
  // like a ref rather than trusted from a query string.
  test('rejects anything that could escape a cache path', () => {
    for (const bad of ['../etc', 'a/b', 'a b', 'x'.repeat(65), 'a\0b']) {
      expect(() => normalizePiAgentName(bad)).toThrow(/invalid agent name/);
    }
  });
  test('empty means "the project default", resolved at compile time', () => {
    expect(normalizePiAgentName('')).toBe('');
    expect(normalizePiAgentName(null)).toBe('');
    expect(normalizePiAgentName(undefined)).toBe('');
  });
  test('accepts the names agents actually have', () => {
    for (const ok of ['kortix', 'code-reviewer', 'data_agent', 'v1.2']) {
      expect(normalizePiAgentName(ok)).toBe(ok);
    }
  });
});

describe('one artifact, one agent', () => {
  test('the agent is part of the cache key and of the stored metadata', async () => {
    const source = await artifactSource();
    const start = source.indexOf('function artifactKey');
    expect(start).toBeGreaterThan(-1);
    const key = source.slice(start, start + 600);
    // Without the agent in the key, two agents on the same sha share one
    // artifact and the second one silently runs the first one's prompt.
    expect(key).toContain('agentName');
    expect(source).toContain('agentName,\n      sha256: artifact.sha256');
  });

  test('an artifact baked for another agent is a cache MISS, not a hit', async () => {
    const source = await artifactSource();
    expect(source).toContain('(metadata.agentName ?? "") !== agentName');
  });

  test('the bake narrows the agent map to exactly one entry', async () => {
    const source = await artifactSource();
    const fn = source.slice(source.indexOf('async function compileArtifact'));
    expect(fn).toContain('agent: { [baked]: one }');
    // A config that cannot be parsed must still produce a bootable bundle.
    expect(fn).toContain('// keep the full config');
  });

  test('the prebuild bakes the default agent BY NAME, or it warms nothing', async () => {
    const source = await prebuildSource();
    expect(source).toContain('resolvePiDefaultAgentName(project, sourceSha)');
    expect(source).toContain('sourceSha, agent)');
  });

  test('the agent comes from the calling session, so the pi snapshot is untouched', async () => {
    const source = await routeSource();
    // Putting the agent in the fetch URL would edit the image's fetch script,
    // change the pi snapshot fingerprint and rebuild the shared template.
    expect(source).toContain('agentOfCallingSession');
    expect(source).toContain('projectSessions.agentName');
    const route = source.slice(source.indexOf("path: '/{project}/compiled-pi-runtime'"));
    expect(route.slice(0, 1200)).toContain('agent: z.string().max(64).optional()');
  });
});
