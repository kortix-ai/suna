import { describe, expect, test } from 'bun:test';
import type { SessionStageState } from './session-stage';
import { stageAfterAgentQuestion, stageAfterAnswer } from './session-stage-backstop';

const at = (value: SessionStageState['value'], needs_approval = false): SessionStageState => ({
  value,
  needs_approval,
  note: null,
  updated_at: '2026-09-04T00:00:00.000Z',
  updated_by: 'agent',
});

describe('stageAfterAgentQuestion', () => {
  test('parks an unstaged or planning card in ready awaiting approval, note from the question', () => {
    const now = new Date('2026-09-04T10:00:00.000Z');
    for (const current of [null, at('backlog'), at('planning'), at('in_progress'), at('ready')]) {
      expect(stageAfterAgentQuestion(current, '  Approve   this plan? ', now)).toEqual({
        value: 'ready',
        needs_approval: true,
        note: 'Approve this plan?',
        updated_at: now.toISOString(),
        updated_by: 'agent',
      });
    }
  });

  test('leaves a card the agent already parked, or moved past, alone', () => {
    expect(stageAfterAgentQuestion(at('ready', true), 'again?')).toBeNull();
    expect(stageAfterAgentQuestion(at('review'), 'ship?')).toBeNull();
    expect(stageAfterAgentQuestion(at('done'), 'anything else?')).toBeNull();
  });

  test('caps the note at 200 characters and nulls an empty one', () => {
    expect(stageAfterAgentQuestion(null, 'x'.repeat(500))?.note).toHaveLength(200);
    expect(stageAfterAgentQuestion(null, '   ')?.note).toBeNull();
  });
});

describe('stageAfterAnswer', () => {
  test('an answer moves a parked card to in_progress, stamped by the answerer', () => {
    const now = new Date('2026-09-04T11:00:00.000Z');
    expect(stageAfterAnswer({ ...at('ready', true), note: 'Plan?' }, 'user-1', now)).toEqual({
      value: 'in_progress',
      needs_approval: false,
      note: 'Plan?',
      updated_at: now.toISOString(),
      updated_by: 'user-1',
    });
  });

  test('is a no-op unless the card was parked awaiting approval', () => {
    for (const current of [null, at('planning'), at('ready'), at('in_progress'), at('review')]) {
      expect(stageAfterAnswer(current, 'user-1')).toBeNull();
    }
  });
});
