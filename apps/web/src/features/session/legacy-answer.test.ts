import { describe, expect, test } from 'bun:test';

import {
  isLegacyAnswerPart,
  isLegacyAnswerTool,
  legacyAnswerPayload,
  legacyAttachment,
  legacyAttachmentsShowInput,
} from './legacy-answer';
import { LEGACY_COMPLETE_PART, LEGACY_COMPLETE_TEXT } from './legacy-answer.fixture';
import { segmentTurn } from './turn/segment-turn';
import { groupSteps } from './action-panel/shared/group-steps';

describe('legacyAnswerPayload', () => {
  test('a migrated `complete` part yields its text, attachment, and follow-ups', () => {
    expect(legacyAnswerPayload(LEGACY_COMPLETE_PART.state.input)).toEqual({
      text: LEGACY_COMPLETE_TEXT,
      attachments: [
        {
          type: 'file',
          path: '/workspace/Macro_Hedge_Positions_Completed.xlsx',
          title: 'Macro_Hedge_Positions_Completed.xlsx',
        },
      ],
      followUps: [
        'Show current mark-to-market and P&L on all six macro hedge positions',
        'Break out the premium spend and current MTM by fund',
      ],
    });
  });

  test('attachments arrive as an array, a JSON string, or a comma-separated string', () => {
    const paths = (attachments: unknown) =>
      legacyAnswerPayload({ text: 'x', attachments })?.attachments.map((a) =>
        a.type === 'file' ? a.path : a.url,
      );
    expect(paths(['a.csv', 'b.pdf'])).toEqual(['/workspace/a.csv', '/workspace/b.pdf']);
    expect(paths('["a.csv","b.pdf"]')).toEqual(['/workspace/a.csv', '/workspace/b.pdf']);
    expect(paths('a.csv, b.pdf ,')).toEqual(['/workspace/a.csv', '/workspace/b.pdf']);
    expect(paths('a.csv,./a.csv')).toEqual(['/workspace/a.csv']);
    expect(paths(undefined)).toEqual([]);
    expect(paths(42)).toEqual([]);
  });

  test('follow-ups ignore non-strings and blanks, and accept a JSON string', () => {
    expect(
      legacyAnswerPayload({ text: 'x', follow_up_prompts: ['one', '', 3, ' two '] })?.followUps,
    ).toEqual(['one', 'two']);
    expect(legacyAnswerPayload({ text: 'x', follow_up_prompts: '["one"]' })?.followUps).toEqual([
      'one',
    ]);
  });

  test('an input with no answer text and no attachment is not a legacy answer', () => {
    expect(legacyAnswerPayload({})).toBeNull();
    expect(legacyAnswerPayload({ text: '   ' })).toBeNull();
    expect(legacyAnswerPayload({ task_id: 't1' })).toBeNull();
    expect(legacyAnswerPayload(null)).toBeNull();
    expect(legacyAnswerPayload(['text'])).toBeNull();
    expect(legacyAnswerPayload({ attachments: 'report.pdf' })?.text).toBe('');
  });
});

describe('legacyAttachment', () => {
  test('resolves legacy references against /workspace', () => {
    expect(legacyAttachment('report.pdf')).toMatchObject({ path: '/workspace/report.pdf' });
    expect(legacyAttachment('./out/report.pdf')).toMatchObject({
      path: '/workspace/out/report.pdf',
      title: 'report.pdf',
    });
    expect(legacyAttachment('workspace/report.pdf')).toMatchObject({
      path: '/workspace/report.pdf',
    });
    expect(legacyAttachment('/workspace/report.pdf')).toMatchObject({
      path: '/workspace/report.pdf',
    });
    expect(legacyAttachment('https://example.com/a')).toEqual({
      type: 'url',
      url: 'https://example.com/a',
      title: 'https://example.com/a',
    });
    expect(legacyAttachment('')).toBeNull();
    expect(legacyAttachment('./')).toBeNull();
    expect(legacyAttachment('/workspace')).toBeNull();
  });
});

describe('legacyAttachmentsShowInput', () => {
  test('one attachment is a single show card, several are a carousel', () => {
    const a = legacyAttachment('a.csv')!;
    const b = legacyAttachment('b.pdf')!;
    expect(legacyAttachmentsShowInput([])).toBeNull();
    expect(legacyAttachmentsShowInput([a])).toEqual({
      type: 'file',
      path: '/workspace/a.csv',
      title: 'a.csv',
    });
    expect(legacyAttachmentsShowInput([a, b])).toEqual({ items: [a, b] });
  });
});

describe('legacy answer parts in the transcript', () => {
  const questionAsk = {
    type: 'tool',
    tool: 'ask',
    callID: 'q1',
    state: { status: 'completed', input: { questions: [{ question: 'Pick', text: 'x' }] } },
  };
  const read = (id: string) => ({
    type: 'tool',
    tool: 'read',
    callID: id,
    id,
    state: { status: 'completed', input: { filePath: '/a' } },
  });

  test('matches legacy complete / ask by shape, never a live question or an unrelated tool', () => {
    expect(isLegacyAnswerPart(LEGACY_COMPLETE_PART)).toBe(true);
    expect(isLegacyAnswerPart({ tool: 'ask', state: { input: { text: 'Which?' } } })).toBe(true);
    expect(isLegacyAnswerPart(questionAsk)).toBe(false);
    expect(isLegacyAnswerPart({ tool: 'complete', state: { input: {} } })).toBe(false);
    expect(isLegacyAnswerPart({ tool: 'task_complete', state: { input: { text: 'x' } } })).toBe(
      false,
    );
    expect(isLegacyAnswerTool('Complete')).toBe(true);
  });

  test('a legacy answer stands alone between bursts instead of folding into one, like show', () => {
    const segments = segmentTurn([read('r1'), LEGACY_COMPLETE_PART, read('r2')] as never);
    expect(segments.map((s) => s.kind)).toEqual(['burst', 'standalone', 'burst']);
  });

  test('a live `ask` question still folds into its burst', () => {
    const segments = segmentTurn([read('r1'), questionAsk, read('r2')] as never);
    expect(segments.map((s) => s.kind)).toEqual(['burst']);
  });

  test('the action panel gives a legacy answer its own step', () => {
    const steps = groupSteps([read('r1'), LEGACY_COMPLETE_PART, read('r2')] as never);
    expect(steps.map((s) => s.parts.map((p) => p.callID))).toEqual([
      ['r1'],
      ['toolu_018gXt8s3w3WGxU5YTDnL5yR'],
      ['r2'],
    ]);
  });
});
