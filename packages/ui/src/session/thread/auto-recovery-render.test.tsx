import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { sessionLogOfV1Rows, sessionLogTurns, type SessionLogTurn } from '@kortix/sdk';

import { TranscriptTurnRow } from '../index';

/**
 * How an automatic provider-error recovery chain renders (KRTX-2597). The
 * harness resumes an interrupted turn with its own `[auto-recovery]` prompt
 * marked `synthetic` on the wire; the chain facts live on the turn model
 * (`turn.internal`, `turn.autoRetry`) and are pinned by the SDK's
 * `auto-recovery.test.ts`. These renders pin the transcript's side of the
 * contract against the real `TranscriptTurnRow`:
 *
 * - the internal continuation renders NO user bubble (the synthetic-only
 *   prompt is not the customer's words — the pre-existing rule background
 *   task notifications already follow, now keyed off the wire flag);
 * - a turn whose failure the harness continued renders no error row — its
 *   row belongs to the continuation's outcome;
 * - the chain's end renders ONE error row, annotated with how many
 *   automatic retries already ran;
 * - a plain conversation is untouched.
 */
const FAILED = { name: 'APIError', data: { message: 'Model host exploded', statusCode: 503, isRetryable: false } };

function rowsFor(shape: 'chain-ok' | 'chain-ends-in-failure' | 'plain' | 'single-failure') {
  if (shape === 'chain-ok') {
    return [
      { info: { id: 'u1', role: 'user', time: { created: 1 } }, parts: [{ id: 't1', type: 'text', text: 'run the deploy' }] },
      { info: { id: 'a1', role: 'assistant', parentID: 'u1', time: { created: 2, completed: 3 }, error: FAILED }, parts: [] },
      { info: { id: 'u2', role: 'user', time: { created: 4 } }, parts: [{ id: 't2', type: 'text', text: '[auto-recovery] The previous turn was interrupted. Continue from where you left off.', synthetic: true }] },
      { info: { id: 'a2', role: 'assistant', parentID: 'u2', time: { created: 5, completed: 6 }, error: FAILED }, parts: [] },
      { info: { id: 'u3', role: 'user', time: { created: 7 } }, parts: [{ id: 't3', type: 'text', text: '[auto-recovery] The previous turn was interrupted. Continue from where you left off.', synthetic: true }] },
      { info: { id: 'a3', role: 'assistant', parentID: 'u3', time: { created: 8, completed: 9 } }, parts: [{ id: 'r3', type: 'text', text: 'deploy done' }] },
    ] as never[];
  }
  if (shape === 'chain-ends-in-failure') {
    return [
      { info: { id: 'u1', role: 'user', time: { created: 1 } }, parts: [{ id: 't1', type: 'text', text: 'run the deploy' }] },
      { info: { id: 'a1', role: 'assistant', parentID: 'u1', time: { created: 2, completed: 3 }, error: FAILED }, parts: [] },
      { info: { id: 'u2', role: 'user', time: { created: 4 } }, parts: [{ id: 't2', type: 'text', text: '[auto-recovery] The previous turn was interrupted. Continue from where you left off.', synthetic: true }] },
      { info: { id: 'a2', role: 'assistant', parentID: 'u2', time: { created: 5, completed: 6 }, error: FAILED }, parts: [] },
    ] as never[];
  }
  if (shape === 'single-failure') {
    return [
      { info: { id: 'u1', role: 'user', time: { created: 1 } }, parts: [{ id: 't1', type: 'text', text: 'run the deploy' }] },
      { info: { id: 'a1', role: 'assistant', parentID: 'u1', time: { created: 2, completed: 3 }, error: FAILED }, parts: [] },
    ] as never[];
  }
  return [
    { info: { id: 'u1', role: 'user', time: { created: 1 } }, parts: [{ id: 't1', type: 'text', text: 'run the deploy' }] },
    { info: { id: 'a1', role: 'assistant', parentID: 'u1', time: { created: 2, completed: 3 } }, parts: [{ id: 'r1', type: 'text', text: 'deploy done' }] },
  ] as never[];
}

const flows: Record<string, SessionLogTurn[]> = Object.fromEntries(
  (['chain-ok', 'chain-ends-in-failure', 'plain', 'single-failure'] as const).map((shape) => [
    shape,
    sessionLogTurns(sessionLogOfV1Rows('p', 'rs', rowsFor(shape)).threads[0]!),
  ]),
);

function turnOf(shape: string, id: string): SessionLogTurn {
  const turn = flows[shape]?.find((t) => t.id === id);
  expect(turn, `${shape}: flow turn ${id} missing`).toBeDefined();
  return turn!;
}

function renderRow(turn: SessionLogTurn): string {
  return renderToStaticMarkup(
    createElement(QueryClientProvider, { client: new QueryClient() },
      createElement(TranscriptTurnRow, {
      turnId: turn.id,
      viewportClassName: '',
      suppressed: false,
      showBusyRow: false,
      turn,
      turnOutcome: {},
      isLast: true,
      ownsPlan: false,
      sessionId: 's',
      sessionStatus: undefined,
      permissions: [],
      questions: [],
      sessionWorking: false,
      isWorkingTurn: false,
      suppressBusyIndicator: false,
      awaitingUser: false,
      pending: false,
      isFirstTurn: false,
      onPermissionReply: () => Promise.resolve(),
      onRewind: () => undefined,
      rewindDisabled: false,
      fullTextState: 'idle',
      onLoadFullText: () => undefined,
      modelOptions: 2,
      }),
    ),
  );
}

describe('an automatic provider-error recovery chain renders as one story (KRTX-2597)', () => {
  test('the harness continuation renders no user bubble', () => {
    const turn = turnOf('chain-ends-in-failure', 'u2');
    expect(turn.internal).toBe(true);
    const html = renderRow(turn);
    expect(html).not.toContain('[auto-recovery]');
    expect(html).not.toContain('Continue from where you left off');
  });

  test('a turn whose failure the harness continued renders no error row', () => {
    const turn = turnOf('chain-ends-in-failure', 'u1');
    expect(turn.autoRetry?.continued).toBe(true);
    const html = renderRow(turn);
    expect(html).not.toContain('Model host exploded');
    expect(html).not.toContain('data-auto-retry-note');
  });

  test('the chain end carries the one error row and the retry count', () => {
    const turn = turnOf('chain-ends-in-failure', 'u2');
    expect(turn.autoRetry).toEqual({ continued: false, retries: 1 });
    const html = renderRow(turn);
    expect(html).toContain('Model host exploded');
    expect(html).toContain('data-auto-retry-note');
    expect(html).toContain('Kortix automatically retried the model once before this failure.');
  });

  test('a chain that recovered ends on the reply: no error row anywhere', () => {
    for (const turn of flows['chain-ok']) {
      expect(renderRow(turn)).not.toContain('Model host exploded');
      expect(renderRow(turn)).not.toContain('data-auto-retry-note');
    }
  });

  test('a plain conversation is untouched: no note, reply intact', () => {
    const turn = turnOf('plain', 'u1');
    expect(turn.internal).toBe(false);
    expect(turn.autoRetry).toBeUndefined();
    const html = renderRow(turn);
    expect(html).toContain('deploy done');
    expect(html).not.toContain('data-auto-retry-note');
  });

  test('a failure with no continuation renders its own row, with no retry note', () => {
    const turn = turnOf('single-failure', 'u1');
    expect(turn.autoRetry).toBeUndefined();
    const html = renderRow(turn);
    expect(html).toContain('Model host exploded');
    expect(html).not.toContain('data-auto-retry-note');
  });
});
