import { describe, expect, test } from 'bun:test';

import { runtimeSupports } from './health';

/**
 * E1: `GET /kortix/health` lists the session features the runtime serves
 * (`session.rewind`, `session.compact`, ...). A host hides the control of a
 * feature that is absent instead of letting it fail with a 501.
 */
describe('runtimeSupports', () => {
  test('a runtime that lists session capabilities serves exactly those', () => {
    const pi = ['file.import', 'file.append', 'session.subagents'];
    expect(runtimeSupports(pi, 'session.subagents')).toBe(true);
    expect(runtimeSupports(pi, 'session.rewind')).toBe(false);
    expect(runtimeSupports(pi, 'session.compact')).toBe(false);
    expect(runtimeSupports(pi, 'session.commands')).toBe(false);
    expect(runtimeSupports(pi, 'session.attach')).toBe(false);
  });

  test('a daemon built before W3 lists no session capability: it runs OpenCode, which serves every one', () => {
    const preW3 = ['file.import', 'file.append', 'config.release.v1'];
    expect(runtimeSupports(preW3, 'session.rewind')).toBe(true);
    expect(runtimeSupports([], 'session.attach')).toBe(true);
  });

  test('before any probe answered, nothing is hidden', () => {
    expect(runtimeSupports(null, 'session.rewind')).toBe(true);
    expect(runtimeSupports(undefined, 'session.commands')).toBe(true);
  });
});
