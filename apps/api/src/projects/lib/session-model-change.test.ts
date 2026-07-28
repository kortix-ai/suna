import { describe, expect, test } from 'bun:test';
import {
  canChangeSessionModel,
  mayChangeSessionModel,
  modelChangeNeedsLivePush,
  validateModelChangeShape,
} from './session-model-change';

describe('validateModelChangeShape', () => {
  test('accepts a normal model ref', () => {
    expect(validateModelChangeShape('anthropic/claude-opus-4-8')).toBeNull();
  });

  test('rejects blank and whitespace-only', () => {
    expect(validateModelChangeShape('')?.code).toBe('INVALID_SESSION_MODEL');
    expect(validateModelChangeShape('   ')?.code).toBe('INVALID_SESSION_MODEL');
  });

  test('rejects embedded whitespace — the create path already does', () => {
    expect(validateModelChangeShape('anthropic/claude opus')?.code).toBe('INVALID_SESSION_MODEL');
  });

  test('rejects an absurdly long id rather than storing it', () => {
    expect(validateModelChangeShape('x'.repeat(129))?.code).toBe('INVALID_SESSION_MODEL');
  });
});

describe('canChangeSessionModel', () => {
  test('running and provisioning sessions may change', () => {
    // provisioning has no live agent yet, but the ROW is what its cold boot
    // reads — writing it early is correct, not premature.
    for (const status of ['running', 'provisioning', 'queued', 'branching']) {
      expect(canChangeSessionModel(status)).toBeNull();
    }
  });

  test('terminal sessions are refused — nothing would consume the value', () => {
    for (const status of ['failed', 'completed', 'stopped']) {
      expect(canChangeSessionModel(status)?.code).toBe('SESSION_NOT_RUNNING');
    }
  });
});

describe('modelChangeNeedsLivePush', () => {
  test('a running session with a genuinely different model needs the restart', () => {
    expect(modelChangeNeedsLivePush({ current: 'a/b', next: 'c/d', status: 'running' })).toBe(true);
  });

  test('a no-op PUT must NOT restart opencode', () => {
    // Restarting costs the user their in-flight turn; re-sending the same model
    // is a legitimate idempotent call and must be free.
    expect(modelChangeNeedsLivePush({ current: 'a/b', next: 'a/b', status: 'running' })).toBe(false);
  });

  test('a session with no box yet just persists — nothing to push to', () => {
    expect(modelChangeNeedsLivePush({ current: null, next: 'c/d', status: 'provisioning' })).toBe(
      false,
    );
  });
});

describe('mayChangeSessionModel — visibility is not mutability', () => {
  test('the session owner may change it', () => {
    expect(mayChangeSessionModel({ canManageSharing: true })).toBe(true);
  });

  test('a project member who can merely SEE a shared session may not', () => {
    // visibility === 'project' makes a session readable by every member, but
    // changing its model restarts opencode and kills the owner's in-flight
    // turn. Sharing routes at r7.ts:1508 / :1689 gate on exactly this.
    expect(mayChangeSessionModel({ canManageSharing: false })).toBe(false);
  });
});
