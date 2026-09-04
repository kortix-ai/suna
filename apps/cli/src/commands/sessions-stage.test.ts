import { describe, expect, test } from 'bun:test';
import { normalizeStage, parseStageCommand } from './sessions-stage';

const SID = '11111111-1111-4111-8111-111111111111';

describe('kortix sessions stage — arg parsing', () => {
  test('normalizes canonical stages and aliases', () => {
    expect(normalizeStage('ready')).toBe('ready');
    expect(normalizeStage('In-Progress')).toBe('in_progress');
    expect(normalizeStage('inprogress')).toBe('in_progress');
    expect(normalizeStage('progress')).toBe('in_progress');
    expect(normalizeStage('plan')).toBe('planning');
    expect(normalizeStage('todo')).toBe('backlog');
    expect(normalizeStage('shipped')).toBeNull();
  });

  test('<session-id> <stage> with flags', () => {
    const cmd = parseStageCommand([SID, 'ready', '--needs-approval', '--note', 'Plan in PLAN.md', '--json'], {});
    expect(cmd).toEqual({
      sessionId: SID,
      stage: 'ready',
      needsApproval: true,
      note: 'Plan in PLAN.md',
      json: true,
      project: undefined,
      host: undefined,
    });
  });

  test('single positional is a stage when it names one, else a session id', () => {
    const inSandbox = parseStageCommand(['review'], { KORTIX_SESSION_ID: SID });
    expect(inSandbox).toMatchObject({ sessionId: SID, stage: 'review' });
    const readOnly = parseStageCommand([SID], {});
    expect(readOnly).toMatchObject({ sessionId: SID, stage: null });
    // A short hex prefix is still a session id lookup, even inside a sandbox.
    expect(parseStageCommand(['ea678c41'], { KORTIX_SESSION_ID: SID })).toMatchObject({
      sessionId: 'ea678c41',
      stage: null,
    });
  });

  test('single non-stage word inside a sandbox is a typo, not a session id', () => {
    expect(() => parseStageCommand(['wizard'], { KORTIX_SESSION_ID: SID })).toThrow(
      /Unknown stage "wizard"/,
    );
  });

  test('no session id anywhere → usage error', () => {
    expect(() => parseStageCommand(['ready'], {})).toThrow(/Pass a session id/);
    expect(() => parseStageCommand([], {})).toThrow(/Pass a session id/);
  });

  test('rejects unknown stage, stray flags, and --needs-approval outside ready', () => {
    expect(() => parseStageCommand([SID, 'shipped'], {})).toThrow(/Unknown stage "shipped"/);
    expect(() => parseStageCommand([SID, 'ready', '--force'], {})).toThrow(/Unknown option "--force"/);
    expect(() => parseStageCommand([SID, 'done', '--needs-approval'], {})).toThrow(/only applies to the "ready" stage/);
    expect(() => parseStageCommand([SID, 'ready', '--note', 'x'.repeat(501)], {})).toThrow(/500 characters/);
  });

  test('--help wins', () => {
    expect(parseStageCommand(['--help'], {})).toBe('help');
  });
});
