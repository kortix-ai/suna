import { describe, expect, test } from 'bun:test';
import {
  releaseVariantFor,
  resolveSessionReleaseAgent,
  type DeclaredAgentRoster,
} from '../session-agent';

function roster(over: Partial<DeclaredAgentRoster> = {}): DeclaredAgentRoster {
  return { enabled: ['kortix', 'reviewer'], defaultAgent: 'kortix', readable: true, governed: true, ...over };
}

describe('resolveSessionReleaseAgent', () => {
  test('a declared agent is kept', () => {
    expect(resolveSessionReleaseAgent('reviewer', roster())).toEqual({ kind: 'declared', agent: 'reviewer' });
  });

  test('the `default` sentinel resolves to the declared default and is NOT a re-point', () => {
    expect(resolveSessionReleaseAgent('default', roster())).toEqual({ kind: 'declared', agent: 'kortix' });
    expect(resolveSessionReleaseAgent(null, roster())).toEqual({ kind: 'declared', agent: 'kortix' });
    expect(resolveSessionReleaseAgent('  ', roster())).toEqual({ kind: 'declared', agent: 'kortix' });
  });

  test('an agent the manifest dropped re-points to the declared default', () => {
    expect(resolveSessionReleaseAgent('retired', roster())).toEqual({
      kind: 'repoint',
      agent: 'kortix',
      dropped: 'retired',
    });
  });

  test('a dropped agent with no declared default is orphaned, never re-pointed', () => {
    expect(resolveSessionReleaseAgent('retired', roster({ defaultAgent: null }))).toEqual({
      kind: 'orphaned',
      dropped: 'retired',
    });
  });

  test('a declared default that is itself not enabled cannot receive a re-point', () => {
    expect(resolveSessionReleaseAgent('retired', roster({ defaultAgent: 'ghost' }))).toEqual({
      kind: 'orphaned',
      dropped: 'retired',
    });
  });

  // INC-2026-09-15. An unreadable manifest proves nothing. Re-pointing on it
  // would move a session onto an agent the project may not even declare.
  test('an unreadable manifest never re-points', () => {
    expect(resolveSessionReleaseAgent('retired', roster({ readable: false }))).toEqual({
      kind: 'declared',
      agent: 'retired',
    });
  });

  test('a project that declares no agents never re-points', () => {
    expect(
      resolveSessionReleaseAgent('anything', roster({ governed: false, enabled: [], defaultAgent: null })),
    ).toEqual({ kind: 'declared', agent: 'anything' });
  });

  test('the platform meta coordinator is never re-pointed', () => {
    expect(resolveSessionReleaseAgent('meta', roster())).toEqual({ kind: 'declared', agent: 'meta' });
  });

  test("OpenCode's own built-ins are never re-pointed", () => {
    expect(resolveSessionReleaseAgent('build', roster())).toEqual({ kind: 'declared', agent: 'build' });
    expect(resolveSessionReleaseAgent('plan', roster())).toEqual({ kind: 'declared', agent: 'plan' });
  });
});

describe('releaseVariantFor', () => {
  test('repository access compiles every agent', () => {
    expect(releaseVariantFor('reviewer', true)).toBe('project');
    expect(releaseVariantFor(null, true)).toBe('project');
  });

  test('without repository access one named agent is compiled', () => {
    expect(releaseVariantFor('reviewer', false)).toBe('agent:reviewer');
  });

  // The whole point: a session with no usable agent still gets a RELEASE.
  // `none` compiles to an empty OpenCode config, which has a non-null etag,
  // so `release_id` is never null and the box never falls back.
  test('no usable agent and no repository access compiles nothing, not a failure', () => {
    expect(releaseVariantFor(null, false)).toBe('none');
  });
});
