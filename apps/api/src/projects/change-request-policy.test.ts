import { describe, expect, test } from 'bun:test';
import { refusesSelfMerge, resolveChangeRequestBase } from './change-request-policy';

const SESSION = 'sess-a';
const OTHER = 'sess-b';

describe('resolveChangeRequestBase', () => {
  const base = { requested: null, sessionBase: null, projectDefault: 'main', actorIsSession: true };

  test('a session started from dev proposes into dev, not the project default', () => {
    // The reported bug, exactly: a `dev` session produced a CR into `main`.
    const out = resolveChangeRequestBase({ ...base, sessionBase: 'dev' });
    expect(out).toEqual({ ok: true, baseRef: 'dev' });
  });

  test('falls back to the project default when the session has no base', () => {
    expect(resolveChangeRequestBase(base)).toEqual({ ok: true, baseRef: 'main' });
  });

  test('a CR with no session at all uses the project default', () => {
    const out = resolveChangeRequestBase({ ...base, actorIsSession: false });
    expect(out).toEqual({ ok: true, baseRef: 'main' });
  });

  test('an agent may NOT retarget its change request at another branch', () => {
    const out = resolveChangeRequestBase({ ...base, sessionBase: 'dev', requested: 'main' });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe('CR_BASE_NOT_SESSION_BASE');
    // The message must name both branches so the agent can explain itself.
    expect(out.error).toContain('dev');
    expect(out.error).toContain('main');
  });

  test('an agent restating its own base is accepted, not refused', () => {
    // The CLI and the dashboard both send base_ref explicitly; echoing the
    // correct value must not be an error.
    const out = resolveChangeRequestBase({ ...base, sessionBase: 'dev', requested: 'dev' });
    expect(out).toEqual({ ok: true, baseRef: 'dev' });
  });

  test('a PERSON may retarget — choosing where work lands is a review decision', () => {
    const out = resolveChangeRequestBase({
      ...base,
      sessionBase: 'dev',
      requested: 'release/1.2',
      actorIsSession: false,
    });
    expect(out).toEqual({ ok: true, baseRef: 'release/1.2' });
  });

  test('a person with no session context keeps an explicit base', () => {
    const out = resolveChangeRequestBase({
      ...base,
      requested: 'release/1.2',
      actorIsSession: false,
    });
    expect(out).toEqual({ ok: true, baseRef: 'release/1.2' });
  });

  test('an agent on a project whose default IS the session base is unaffected', () => {
    const out = resolveChangeRequestBase({ ...base, sessionBase: 'main', requested: 'main' });
    expect(out).toEqual({ ok: true, baseRef: 'main' });
  });
});

describe('refusesSelfMerge', () => {
  test('a session may not merge the change request it opened', () => {
    expect(refusesSelfMerge({ actingSessionId: SESSION, originSessionId: SESSION })).toBe(true);
  });

  test('a session MAY merge a change request opened by someone else', () => {
    expect(refusesSelfMerge({ actingSessionId: SESSION, originSessionId: OTHER })).toBe(false);
  });

  test('a session may merge a change request a PERSON opened', () => {
    expect(refusesSelfMerge({ actingSessionId: SESSION, originSessionId: null })).toBe(false);
  });

  test('a person is never refused', () => {
    expect(refusesSelfMerge({ actingSessionId: null, originSessionId: SESSION })).toBe(false);
    expect(refusesSelfMerge({ actingSessionId: null, originSessionId: null })).toBe(false);
  });

  test('two null ids are not treated as a match', () => {
    // Guards the obvious `a === b` bug: without the truthiness check, a person
    // merging a person-opened CR would be refused.
    expect(refusesSelfMerge({ actingSessionId: null, originSessionId: null })).toBe(false);
  });
});
