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
    expect(source).toContain("auth.principal.kind === 'session' ? auth.principal.sessionId : null");
    expect(source).toContain('agentOfCallingSession(callerSessionId)');
    expect(source).toContain('projectSessions.agentName');
    // The id must come from the AUTH RESULT: this route authenticates its own
    // token and never runs the middleware that populates the Hono context, so
    // reading the context there silently yielded '' and every artifact was
    // baked under the empty name.
    expect(source).not.toContain('callerKortixSessionId');
    const route = source.slice(source.indexOf("path: '/{project}/compiled-pi-runtime'"));
    expect(route.slice(0, 1200)).toContain('agent: z.string().max(64).optional()');
  });
});

async function storeSource(): Promise<string> {
  return Bun.file(new URL('./pi-runtime-store.ts', import.meta.url)).text();
}

describe('durable shared artifact store', () => {
  test('a local miss asks the store BEFORE recompiling — boot must not need git', async () => {
    const source = await artifactSource();
    const readAt = source.indexOf('readStoredPiRuntimeArtifact(key)');
    const compileAt = source.indexOf('const build = compileArtifact(');
    expect(readAt).toBeGreaterThan(-1);
    // Order matters: recompiling reaches the mirror, and on 2026-08-29 a git
    // outage made that path boot sessions with no agent config at all.
    expect(readAt).toBeLessThan(compileAt);
  });

  test('a compiled artifact is published for every other replica and every later deploy', async () => {
    const source = await artifactSource();
    expect(source).toContain('putStoredPiRuntimeArtifact({');
    expect(source).toContain('content: Buffer.from(artifact.source)');
  });

  test('hydration refuses bytes that do not match their digest', async () => {
    const source = await artifactSource();
    const fn = source.slice(source.indexOf('async function hydrateFromStore'));
    // A corrupt row must send the caller to a clean recompile, never be served.
    expect(fn.slice(0, 900)).toContain('digest !== record.sha256');
    expect(fn.slice(0, 900)).toContain('return null');
  });

  test('neither reading nor publishing can fail a boot', async () => {
    const source = await storeSource();
    for (const fn of ['readStoredPiRuntimeArtifact', 'putStoredPiRuntimeArtifact']) {
      const body = source.slice(source.indexOf(`export async function ${fn}`));
      expect(body.slice(0, 1400)).toContain('catch');
    }
    // Publishing is an optimisation; a duplicate is a no-op, not an error.
    expect(source).toContain('onConflictDoNothing()');
  });

  test('retention is bounded per (project, agent)', async () => {
    const source = await storeSource();
    expect(source).toContain('RETAIN_PER_AGENT');
    expect(source).toContain('rows.slice(retain)');
  });

  test('the push prebuild forces the mirror forward before resolving the tip', async () => {
    const source = await prebuildSource();
    const fn = source.slice(source.indexOf('export async function prebuildDefaultBranchPiRuntime'));
    const force = fn.indexOf('refreshMirror(project, true)');
    const resolve = fn.indexOf('resolveTip(project, project.defaultBranch)');
    expect(force).toBeGreaterThan(-1);
    // Without this the tip resolves through a 60s-unforced refresh that the
    // push itself just satisfied, so the prebuild compiles the PREVIOUS commit
    // and the first session on the new one compiles on demand.
    expect(force).toBeLessThan(resolve);
  });

  test('the OpenCode prebuild forces the mirror forward too', async () => {
    const source = await prebuildSource();
    const fn = source.slice(
      source.indexOf('export async function prebuildDefaultBranchArtifacts'),
      source.indexOf('export async function prebuildDefaultBranchPiRuntime'),
    );
    // Same trap, same fix: without it a push prebuilds the PREVIOUS commit.
    const force = fn.indexOf('refreshMirror(project, true)');
    const resolve = fn.indexOf('dependencies.resolveTip(');
    expect(force).toBeGreaterThan(-1);
    expect(force).toBeLessThan(resolve);
  });

  test('a push prebuilds EVERY declared agent, best-effort', async () => {
    const source = await prebuildSource();
    expect(source).toContain('listPiAgentNames(project, sourceSha)');
    expect(source).toContain("name !== defaultAgent");
    // One broken agent must not fail the push or the caller's artifact.
    expect(source).toContain('.catch(');
  });
});
