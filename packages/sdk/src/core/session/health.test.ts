import { describe, expect, test } from 'bun:test';

import { hasSessionDesktop, runtimeSupports } from './health';

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

/**
 * The desktop is a property of the session's computer, not of its runtime: the
 * daemon lists `machine.desktop` when the image installs it. My Kortix's
 * minimal image, and a custom template on another base, do not.
 */
describe('hasSessionDesktop', () => {
  test('true only when the daemon lists machine.desktop', () => {
    expect(hasSessionDesktop(['file.import', 'machine.desktop', 'session.subagents'])).toBe(true);
    expect(hasSessionDesktop(['file.import', 'file.append', 'session.subagents'])).toBe(false);
  });

  test('an older daemon that lists nothing about the desktop has none to show', () => {
    expect(hasSessionDesktop([])).toBe(false);
    expect(hasSessionDesktop(['file.import', 'config.release.v1'])).toBe(false);
  });

  test('before any probe answered, the desktop stays hidden', () => {
    expect(hasSessionDesktop(null)).toBe(false);
    expect(hasSessionDesktop(undefined)).toBe(false);
  });
});
