/**
 * A page reload in the middle of a step, from the store to the turn's segments.
 *
 * The reported shape (local stack, 2026-09-23): the model thought for 53 s,
 * wrote one answer line, and started a file write. Live, the step read
 * "Thought for 53s" + the answer line + "Writing". After a reload the same
 * step showed the model's REASONING as reply prose, the answer line was gone,
 * and the burst counted one step fewer — the reasoning had become a text part.
 *
 * Two facts combine on a reload:
 *  - a `message.part.delta` frame names no part type, so the store's stub for
 *    a part it has not seen yet is typed `text` — reasoning included;
 *  - OpenCode persists an open part EMPTY, so the transcript page cannot
 *    contradict the stub's text, only its type.
 *
 * These tests drive the REAL store (`@kortix/sdk`) with the wire frames a
 * reloaded tab receives, then run the turn through the same segmentation the
 * transcript renders, and assert what a reader would see.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { useSessionStateStore } from '@kortix/sdk/react';
import type { Part } from '@/ui';
import { burstSummary } from './burst-summary';
import { mergeBurstSteps } from './merge-steps';
import { segmentTurn } from './segment-turn';
import { stepLabel } from './step-label';

const SID = 'ses_reload_web';
const USER = 'msg_0000000000010000000000';
const ASST = 'msg_0000000000020000000000';
const REASONING =
  'Now I have rich data. I have products: 1. alpha 2. beta. That is plenty. Let me decide file placement.';
const ANSWER = 'I now have 12 products plus market context. Building the outputs…';

let seq = 0;
const store = () => useSessionStateStore.getState();

function user() {
  return {
    id: USER,
    sessionID: SID,
    role: 'user',
    time: { created: 1 },
    agent: 'build',
    model: { providerID: 'p', modelID: 'm' },
  };
}

function assistant() {
  return {
    id: ASST,
    sessionID: SID,
    role: 'assistant',
    time: { created: 2 },
    parentID: USER,
    modelID: 'm',
    providerID: 'p',
    mode: 'build',
    agent: 'build',
    path: { cwd: '/', root: '/' },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  };
}

const stepStart = { id: 'prt_a_step', sessionID: SID, messageID: ASST, type: 'step-start' };
const reasoningOpen = {
  id: 'prt_b_reason',
  sessionID: SID,
  messageID: ASST,
  type: 'reasoning',
  text: '',
  time: { start: 1_000 },
};
const reasoningEnded = { ...reasoningOpen, text: REASONING, time: { start: 1_000, end: 54_000 } };
const textOpen = {
  id: 'prt_c_text',
  sessionID: SID,
  messageID: ASST,
  type: 'text',
  text: '',
  time: { start: 54_001 },
};
const writeRunning = {
  id: 'prt_d_write',
  sessionID: SID,
  messageID: ASST,
  type: 'tool',
  tool: 'write',
  callID: 'call_write',
  state: { status: 'running', input: { filePath: '/workspace/research.md' }, time: { start: 60_000 } },
};

function hydrate(parts: unknown[]) {
  store().hydrate(SID, [
    { info: user(), parts: [] },
    { info: assistant(), parts: parts as Part[] },
  ] as never);
}

function frame(type: string, properties: Record<string, unknown>) {
  store().applyEvent({ id: `evt_${++seq}`, type, properties } as never);
}

function delta(partID: string, chunk: string) {
  frame('message.part.delta', { sessionID: SID, messageID: ASST, partID, field: 'text', delta: chunk });
}

function stepParts(): Part[] {
  const turn = store()
    .getMessages(SID)
    .find((m) => m.info.id === ASST);
  return (turn?.parts ?? []) as Part[];
}

/** What the transcript renders for the step: its prose and its bursts. */
function rendered() {
  const segments = segmentTurn(stepParts());
  const prose = segments.flatMap((s) => (s.kind === 'text' ? [s.part.text] : []));
  const bursts = segments.flatMap((s) => (s.kind === 'burst' ? [s.parts] : []));
  const steps = bursts.flatMap((parts) => mergeBurstSteps(parts, (p) => stepLabel(p).tier));
  const thoughts = steps.filter((s) => s.kind === 'thought');
  const total = bursts.reduce((n, parts) => n + burstSummary(parts).total, 0);
  return { prose, thoughts, total };
}

beforeEach(() => {
  store().reset();
  store().hydrate(SID, [{ info: user(), parts: [] }] as never);
});

describe('reload while the model is thinking', () => {
  test('the reasoning the reconnected stream delivers stays a thought — never reply prose', () => {
    // The reloaded tab's stream is up before its transcript read: it meets
    // the open reasoning as bare deltas.
    delta('prt_b_reason', 'Now I have rich data. ');
    delta('prt_b_reason', 'I have products: 1. alpha 2. beta.');
    hydrate([stepStart, reasoningOpen]);

    const live = rendered();
    expect(live.prose).toEqual([]);
    expect(live.thoughts).toHaveLength(1);
    // Still streaming: the one thought row that may render open and live.
    expect(live.thoughts[0]).toMatchObject({ running: true });

    // The reasoning ends; the answer streams; a tool starts.
    frame('message.part.updated', { sessionID: SID, part: reasoningEnded });
    frame('message.part.updated', { sessionID: SID, part: textOpen });
    delta('prt_c_text', ANSWER);
    frame('message.part.updated', { sessionID: SID, part: writeRunning });

    const after = rendered();
    expect(after.prose).toEqual([ANSWER]);
    expect(after.prose.join(' ')).not.toContain('Now I have rich data');
    expect(after.thoughts).toHaveLength(1);
    expect(after.thoughts[0]).toMatchObject({ running: false, texts: [REASONING] });
    // Thought + write: two steps, the same count the live tab showed.
    expect(after.total).toBe(2);
  });
});

describe('reload after the reasoning ended, while the answer streams', () => {
  test('the page carries the in-flight answer; the ended reasoning is a settled thought', () => {
    // The daemon's transcript list overlays the streamed text onto the open
    // text part (OpenCode itself persisted it empty).
    delta('prt_c_text', ' Building the outputs…');
    hydrate([stepStart, reasoningEnded, { ...textOpen, text: ANSWER }, writeRunning]);

    const view = rendered();
    expect(view.prose).toEqual([ANSWER]);
    expect(view.thoughts).toHaveLength(1);
    expect(view.thoughts[0]).toMatchObject({ running: false, texts: [REASONING] });
    expect(view.total).toBe(2);

    // The stream keeps appending after the reload, without a doubled span.
    delta('prt_c_text', ' Done.');
    expect(rendered().prose).toEqual([`${ANSWER} Done.`]);
  });

  test('from a runtime that does NOT overlay the text, the step still renders honestly', () => {
    hydrate([stepStart, reasoningEnded, textOpen, writeRunning]);

    const view = rendered();
    // No answer yet — but never the reasoning in its place.
    expect(view.prose).toEqual([]);
    expect(view.thoughts).toHaveLength(1);
    expect(view.thoughts[0]).toMatchObject({ running: false, texts: [REASONING] });
  });
});
