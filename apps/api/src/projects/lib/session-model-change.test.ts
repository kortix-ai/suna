import { describe, expect, test } from 'bun:test';
import {
  canChangeSessionModel,
  mayChangeSessionModel,
  modelChangeNeedsLivePush,
  modelChangeResult,
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
    // turn. The sharing route in routes/project-sessions.ts gate on exactly this.
    expect(mayChangeSessionModel({ canManageSharing: false })).toBe(false);
  });
});

describe('modelChangeResult — a half-applied change must never read as done', () => {
  test('a live push that succeeded is applied', () => {
    const result = modelChangeResult({
      model: 'kortix/claude-sonnet-4.6',
      needsPush: true,
      push: { applied: true },
    });
    expect(result).toEqual({ opencode_model: 'kortix/claude-sonnet-4.6', applied_live: true });
  });

  test('a live push that FAILED is flagged, with the upstream reason', () => {
    const result = modelChangeResult({
      model: 'kortix/deepseek-v4-flash',
      needsPush: true,
      push: { applied: false, reason: '502 upstream-closed-before-headers' },
    });
    expect(result).toEqual({
      opencode_model: 'kortix/deepseek-v4-flash',
      applied_live: false,
      push_failed: true,
      detail: 'stored, but not pushed: 502 upstream-closed-before-headers',
    });
  });

  test('a failed push with no reason still flags the failure', () => {
    const result = modelChangeResult({
      model: 'kortix/glm-5.2',
      needsPush: true,
      push: { applied: false },
    });
    expect(result.push_failed).toBe(true);
    expect(result.detail).toBe('stored, but not pushed: unknown');
  });

  test('no push needed on a cold session is NOT a failure', () => {
    const result = modelChangeResult({
      model: 'kortix/claude-opus-4.8',
      needsPush: false,
      current: 'kortix/claude-sonnet-4.6',
    });
    expect(result).toEqual({
      opencode_model: 'kortix/claude-opus-4.8',
      applied_live: false,
      detail: 'stored — applies when the sandbox next starts',
    });
    expect(result.push_failed).toBeUndefined();
  });

  test('re-selecting the same model is a benign no-op, not a failure', () => {
    const result = modelChangeResult({
      model: 'kortix/claude-opus-4.8',
      needsPush: false,
      current: 'kortix/claude-opus-4.8',
    });
    expect(result).toEqual({
      opencode_model: 'kortix/claude-opus-4.8',
      applied_live: false,
      detail: 'already set to this model',
    });
    expect(result.push_failed).toBeUndefined();
  });
});
