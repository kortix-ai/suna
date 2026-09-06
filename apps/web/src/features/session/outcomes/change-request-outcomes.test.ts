import { describe, expect, test } from 'bun:test';

import { changeRequestOutcomes } from './change-request-outcomes';

type Cr = Parameters<typeof changeRequestOutcomes>[0][number];

function cr(over: Partial<Cr> = {}): Cr {
  return {
    cr_id: 'cr_1',
    number: 12,
    title: 'Add rate limiting',
    description: 'Adds a token bucket to the public API.',
    base_ref: 'main',
    head_ref: 'session-a1b2',
    status: 'open',
    origin_session_id: 'sess_1',
    created_at: '2026-08-31T10:00:00.000Z',
    ...over,
  } as Cr;
}

describe('changeRequestOutcomes', () => {
  test('keeps only the change requests this session produced', () => {
    const out = changeRequestOutcomes(
      [cr(), cr({ cr_id: 'cr_2', origin_session_id: 'other' })],
      'sess_1',
    );
    expect(out.map((o) => o.id)).toEqual(['cr:cr_1']);
  });

  test('an unknown session produces nothing rather than everything', () => {
    // The guard that matters: a missing sessionId must never fall through to
    // "show every change request in the project" on someone else's turn.
    expect(changeRequestOutcomes([cr()], undefined)).toEqual([]);
  });

  test('a change request with no origin session is never attributed to a turn', () => {
    expect(changeRequestOutcomes([cr({ origin_session_id: null })], 'sess_1')).toEqual([]);
  });

  test('the title is the agent’s words alone — no number, no branch name', () => {
    const [out] = changeRequestOutcomes([cr()], 'sess_1');
    expect(out.title).toBe('Add rate limiting');
    expect(out.title).not.toContain('#12');
    expect(out.title).not.toContain('session-a1b2');
  });

  test('meta carries the reference, and no branch name reaches the screen', () => {
    const [out] = changeRequestOutcomes([cr()], 'sess_1');
    expect(out.meta).toEqual(['Change request #12']);
    // `into main` is gone. A branch name was the one piece of git still
    // reaching a non-technical reader, and it told them nothing actionable.
    expect(out.meta.join(' ')).not.toContain('main');
  });

  test('an open change request is waiting for a human', () => {
    const [out] = changeRequestOutcomes([cr()], 'sess_1');
    expect(out.status).toEqual({ label: 'Waiting for you', tone: 'warning' });
    expect(out.action.label).toBe('Review');
  });

  test('a merged change request reads as done and is no longer a review task', () => {
    const [out] = changeRequestOutcomes([cr({ status: 'merged' })], 'sess_1');
    expect(out.status).toEqual({ label: 'Applied', tone: 'success' });
    expect(out.action.label).toBe('View');
  });

  test('a closed change request reads as closed, not failed', () => {
    const [out] = changeRequestOutcomes([cr({ status: 'closed' })], 'sess_1');
    expect(out.status.label).toBe('Closed');
    expect(out.status.tone).toBe('neutral');
  });

  test('the resource link is the shareable one, and the action opens the modal', () => {
    const [out] = changeRequestOutcomes([cr()], 'sess_1');
    expect(out.resourceHref).toBe('?cr=cr_1');
    expect(out.action.intent).toBe('open');
  });

  test('the timestamp is epoch ms, so it can anchor to a turn span', () => {
    const [out] = changeRequestOutcomes([cr()], 'sess_1');
    expect(out.at).toBe(Date.parse('2026-08-31T10:00:00.000Z'));
  });

  test('an unparseable timestamp yields 0 rather than NaN', () => {
    // NaN would sort unpredictably and never match a turn span.
    const [out] = changeRequestOutcomes([cr({ created_at: 'not a date' })], 'sess_1');
    expect(out.at).toBe(0);
  });

  test('an empty description falls back to a sentence, not to blank space', () => {
    // `ChangeRequest.description` is typed `string`, not `string | null`
    // (verified at change-requests.ts:24), so the real-world absent case is the
    // empty string — `null` would not even typecheck through `Partial<>`.
    const [out] = changeRequestOutcomes([cr({ description: '' })], 'sess_1');
    expect(out.description).toBe('Ready for you to look over.');
  });

  test('a whitespace-only description also falls back', () => {
    const [out] = changeRequestOutcomes([cr({ description: '   \n ' })], 'sess_1');
    expect(out.description).toBe('Ready for you to look over.');
  });
});
