import { describe, expect, test } from 'bun:test';
import { sandboxTokenMayActOnSession } from './sandbox-token-session';

describe('sandboxTokenMayActOnSession', () => {
  test('a sandbox token may act on its OWN session', () => {
    expect(sandboxTokenMayActOnSession('sess-a', 'sess-a')).toBe(true);
  });

  test("a sandbox token may NOT act on a sibling session in the same project", () => {
    // The IDOR: same project, different session — turn-question let this through
    // because it only scoped session_id to the project.
    expect(sandboxTokenMayActOnSession('sess-a', 'sess-b')).toBe(false);
  });

  test('a missing sandbox binding is refused, never treated as a wildcard', () => {
    expect(sandboxTokenMayActOnSession(null, 'sess-a')).toBe(false);
    expect(sandboxTokenMayActOnSession(undefined, 'sess-a')).toBe(false);
    expect(sandboxTokenMayActOnSession('', 'sess-a')).toBe(false);
  });
});

describe('commit-push shares the same invariant', () => {
  test('a sandbox may push its OWN session', () => {
    expect(sandboxTokenMayActOnSession('sess-a', 'sess-a')).toBe(true);
  });

  test('a sandbox may NOT push a sibling session', () => {
    // `POST /sessions/:sessionId/commit-push` gates on PROJECT_GITOPS_PUSH,
    // which is project-wide — and in KaaB every end-user's sandbox holds it,
    // because they all share the wrapper's credential. Without the binding,
    // end-user A's agent could commit and push end-user B's working tree to B's
    // branch: a write into another end-user's repository state.
    expect(sandboxTokenMayActOnSession('sess-a', 'sess-b')).toBe(false);
  });
});
