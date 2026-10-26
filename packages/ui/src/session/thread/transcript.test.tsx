import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';

import { sessionLogOfV1Rows, sessionLogTurns, SESSION_LOG_SCHEMA, SESSION_LOG_MINOR, type SessionLogMessage, type SessionLogTurn } from '@kortix/sdk';

import { AfterFirstPromptContext } from './after-first-prompt';
import { TranscriptRowsContext } from './transcript-rows';
import { SessionTurn, TranscriptTurnRow, openTextBlock } from './transcript';

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

describe('openTextBlock: only the text block still being written streams (KRTX-2932)', () => {
  const text = (id: string) => ({ type: 'text' as const, id, text: `${id} text` });
  const tool = { type: 'tool_call', id: 't1' };
  const reply = (blocks: unknown[], completed_at: string | null) =>
    ({ message_id: 'm1', completed_at, blocks }) as unknown as SessionLogTurn['assistant'][number];

  test('the last text block of an open reply is open', () => {
    const last = text('b2');
    expect(openTextBlock(true, reply([text('b1'), tool, last], null))).toEqual({ block: last, messageId: 'm1' });
  });

  test('a text block followed by another block has ended', () => {
    expect(openTextBlock(true, reply([text('b1'), tool], null))).toBeNull();
  });

  test('a completed reply streams nothing while the turn still reads as working', () => {
    expect(openTextBlock(true, reply([text('b1')], '2026-10-20T00:00:00Z'))).toBeNull();
  });

  test('a settled turn streams nothing', () => {
    expect(openTextBlock(false, reply([text('b1')], null))).toBeNull();
    expect(openTextBlock(true, undefined)).toBeNull();
  });
});

describe('the slot under the first prompt (a channel thread\'s "N replies")', () => {
  const [answered] = sessionLogTurns(
    sessionLogOfV1Rows(
      's',
      'rs',
      [
        { info: { id: 'p0', role: 'user', time: { created: 1 } }, parts: [{ id: 'pt', type: 'text', text: 'the parent message' }] },
        { info: { id: 'r0', role: 'assistant', parentID: 'p0', time: { created: 2 } }, parts: [{ id: 'rt', type: 'text', text: 'the first reply' }] },
      ] as never[],
    ).threads[0]!,
  );
  const render = (isFirstTurn: boolean) =>
    renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        createElement(
          AfterFirstPromptContext.Provider,
          { value: createElement('hr', { 'data-probe': 'replies' }) },
          createElement(TranscriptTurnRow, {
            turnId: answered!.id,
            viewportClassName: '',
            suppressed: false,
            showBusyRow: false,
            turn: answered!,
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
            isFirstTurn,
            onPermissionReply: () => Promise.resolve(),
            onRewind: () => undefined,
            rewindDisabled: false,
            fullTextState: 'idle',
            onLoadFullText: () => undefined,
          }),
        ),
      ),
    );

  test('the first turn draws it between the parent message and the reply', () => {
    const html = render(true);
    const parent = html.indexOf('the parent message');
    const slot = html.indexOf('data-probe="replies"');
    const reply = html.indexOf('the first reply');
    expect(parent).toBeGreaterThan(-1);
    expect(slot).toBeGreaterThan(parent);
    expect(reply).toBeGreaterThan(slot);
  });

  test('a later turn does not draw it', () => {
    const html = render(false);
    expect(html).toContain('the parent message');
    expect(html).not.toContain('data-probe');
  });
});

describe('message rows (a channel thread panel)', () => {
  const [turn] = sessionLogTurns(
    sessionLogOfV1Rows(
      's',
      'rs',
      [
        { info: { id: 'q0', role: 'user', time: { created: 1 } }, parts: [{ id: 'qt', type: 'text', text: 'spawned prompt' }] },
        { info: { id: 'q1', role: 'assistant', parentID: 'q0', time: { created: 2 } }, parts: [{ id: 'qr', type: 'text', text: 'the answer' }] },
      ] as never[],
    ).threads[0]!,
  );
  const render = (author: Parameters<typeof TranscriptTurnRow>[0]['author']) =>
    renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        createElement(
          TranscriptRowsContext.Provider,
          {
            value: {
              agent: 'Kortix',
              owner: { name: 'Thread Owner', email: 'owner@example.test', avatarUrl: null },
              unknownAuthor: 'Someone',
            },
          },
          createElement(TranscriptTurnRow, {
            turnId: turn!.id,
            viewportClassName: '',
            suppressed: false,
            showBusyRow: false,
            turn: turn!,
            author,
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
            isFirstTurn: true,
            onPermissionReply: () => Promise.resolve(),
            onRewind: () => undefined,
            rewindDisabled: false,
            fullTextState: 'idle',
            onLoadFullText: () => undefined,
          }),
        ),
      ),
    );

  test('a prompt with no recorded author is the thread owner\'s row', () => {
    const html = render(undefined);
    expect(html).toContain('Thread Owner');
    expect(html).toContain('data-slot="message-row"');
  });

  test("a prompt another session's agent sent is that agent's row, not the owner's", () => {
    const html = render({ kind: 'session', session_id: 'ses_1', name: 'Coordinator', agent: 'research-bot' });
    const prompt = html.indexOf('spawned prompt');
    const row = html.lastIndexOf('data-slot="message-row"', prompt);
    const header = html.slice(row, prompt);
    expect(header).toContain('Research-Bot');
    expect(header).not.toContain('Thread Owner');
  });
});

// KRTX-3034: exercise the real transcript, not a reconstruction of its JSX.
test('one settled turn folds activity before and after compaction behind one Worked row', () => {
  const message = (id: string, role: 'user' | 'assistant', blocks: SessionLogMessage['blocks'], extra: Partial<SessionLogMessage> = {}): SessionLogMessage => ({
    schema: SESSION_LOG_SCHEMA, v: SESSION_LOG_MINOR, message_id: id, thread_id: 'synthetic', seq: 1,
    role, kind: 'turn', status: 'complete', in_context: true, model: null, usage: null,
    finish: null, error: null, created_at: '2026-01-01T00:00:00Z', completed_at: '2026-01-01T00:00:08Z',
    producer: { harness: 'pi', harness_version: '1', adapter_version: '1' }, blocks, ...extra,
  });
  const turns = sessionLogTurns({ schema: SESSION_LOG_SCHEMA, v: SESSION_LOG_MINOR, thread_id: 'synthetic', parent_thread_id: null, spawned_by: null, agent: null, title: null, created_at: '', messages: [
    message('prompt', 'user', [{ type: 'text', id: 'q', text: 'Check synthetic grouping' }]),
    message('before', 'assistant', [{ type: 'reasoning', id: 'thinking', text: 'Work before compaction' }], { reply_to: 'prompt' }),
    message('marker', 'user', [{ type: 'compaction', id: 'cp', summary: 'Synthetic retained context', first_kept_message_id: null }], { kind: 'compaction' }),
    message('after', 'assistant', [{ type: 'text', id: 'answer', text: 'Synthetic final answer' }], { reply_to: 'prompt' }),
  ] }, { foldCompactions: true });
  const turn = turns[0];
  if (!turn) throw new Error('Missing synthetic turn');
  expect(turns).toHaveLength(1);
  const html = renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(SessionTurn, {
    turn, turnOutcome: {}, sessionId: 'synthetic', sessionStatus: undefined, isLast: true, ownsPlan: false,
    permissions: [], questions: [], sessionWorking: false, isWorkingTurn: false,
    suppressBusyIndicator: false, awaitingUser: false, pending: false, isFirstTurn: true,
    onPermissionReply: async () => {}, onRewind: () => {}, rewindDisabled: true,
  })));
  expect(html.match(/group\/work/g)).toHaveLength(1);
  expect(html).toContain('Synthetic final answer');
  expect(html).not.toContain('Context automatically compacted');
  expect(html).not.toContain('Synthetic retained context');
});
