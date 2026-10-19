import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { sessionLogOfV1Rows, sessionLogTurns, type SessionLogTurn } from '@kortix/sdk';

import { TranscriptTurnRow } from './transcript';

/**
 * `TranscriptTurnRow` is the only production site that decides WHICH turns
 * carry `data-turn-continues` (transcript.tsx, the `continues` call arg), and
 * `useAutoScroll.sizeRoom` refuses to anchor on any row that has it. Losing or
 * narrowing the derivation here re-opens the running-compaction blank page
 * (KRTX-2565) with the viewport and hook pins still green — the attribute
 * simply never reaches the DOM. These renders pin the real component, so the
 * derivation itself is under test, not the file's text.
 */
const flow = sessionLogTurns(
  sessionLogOfV1Rows(
    's',
    'rs',
    [
      { info: { id: 'u0', role: 'user', time: { created: 1 } }, parts: [{ id: 't0', type: 'text', text: 'first prompt' }] },
      { info: { id: 'u1', role: 'user', time: { created: 3 } }, parts: [{ id: 'c1', type: 'compaction' }] },
      { info: { id: 'a1', role: 'assistant', parentID: 'u1', summary: true, time: { created: 4 } }, parts: [] },
      { info: { id: 'a2', role: 'assistant', parentID: 'u1', agent: 'build', time: { created: 5 } }, parts: [{ id: 'x1', type: 'text', text: 'work after compaction' }] },
    ] as never[],
  ).threads[0]!,
);

function turnBy(id: string): SessionLogTurn {
  const turn = flow.find((t) => t.id === id);
  expect(turn, `flow turn ${id} missing`).toBeDefined();
  return turn!;
}

function renderRow(turn: SessionLogTurn): string {
  return renderToStaticMarkup(
    createElement(TranscriptTurnRow, {
      turnId: turn.id,
      viewportClassName: '',
      suppressed: true, // the viewport wiring is what is under test; the turn body has its own pins
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
    }),
  );
}

describe('the transcript row marks the turns auto-scroll must never anchor on', () => {
  test('a compaction turn and the work continuing it carry data-turn-continues', () => {
    expect(turnBy('u1').compaction).not.toBeNull();
    expect(turnBy('u1:continued').continues).not.toBeNull();
    expect(renderRow(turnBy('u1'))).toContain('data-turn-continues="true"');
    expect(renderRow(turnBy('u1:continued'))).toContain('data-turn-continues="true"');
  });

  test('a settled turn of its own carries none — the anchor may land on it', () => {
    expect(turnBy('u0').compaction).toBeNull();
    expect(turnBy('u0').continues).toBeNull();
    expect(renderRow(turnBy('u0'))).not.toContain('data-turn-continues');
  });
});
