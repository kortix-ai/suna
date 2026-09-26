import { describe, expect, test } from 'bun:test';

import { groupMessagesIntoTurns } from './grouping';
import type { MessageWithPartsLike } from './types';

/**
 * A long automated run is ONE user prompt followed by hundreds of assistant
 * messages. A session page loads a bounded tail of the transcript, so the
 * prompt that started the run is often not loaded: every loaded assistant
 * message is an orphan whose parent turn is missing. These tests pin how such
 * a tail groups. It used to be prepended one message at a time, which
 * reversed the whole run and filed it under whatever later prompt was loaded.
 */

const T0 = Date.parse('2026-09-26T12:00:00Z');

/** An OpenCode wire id minted at `ms`, as `Identifier.ascending` writes it. */
function wireId(ms: number, tag: string): string {
  const clock = (BigInt(ms) * BigInt(0x1000)) & BigInt(0xffffffffffff);
  return `msg_${clock.toString(16).padStart(12, '0')}${tag.padEnd(14, 'x').slice(0, 14)}`;
}

function user(ms: number, tag: string): MessageWithPartsLike {
  return {
    info: { id: wireId(ms, tag), role: 'user', time: { created: ms } },
    parts: [{ id: `prt_${tag}`, type: 'text', text: tag }],
  } as MessageWithPartsLike;
}

function assistant(ms: number, tag: string, parentID?: string): MessageWithPartsLike {
  return {
    info: {
      id: wireId(ms, tag),
      role: 'assistant',
      time: { created: ms, completed: ms + 1 },
      tokens: { input: 1, output: 1, reasoning: 0 },
      ...(parentID ? { parentID } : {}),
    },
    parts: [{ id: `prt_${tag}`, type: 'text', text: tag }],
  } as MessageWithPartsLike;
}

const texts = (messages: MessageWithPartsLike[]) =>
  messages.map((m) => (m.parts[0] as { text?: string } | undefined)?.text ?? '');

/** The prompt that started the run. Never in the loaded window below. */
const RUN_PROMPT = wireId(T0, 'run-prompt');

function runTail(): MessageWithPartsLike[] {
  return [
    assistant(T0 + 1_000, 'typecheck', RUN_PROMPT),
    assistant(T0 + 2_000, 'formatting', RUN_PROMPT),
    assistant(T0 + 3_000, 'learnings', RUN_PROMPT),
    assistant(T0 + 4_000, 'commit', RUN_PROMPT),
    assistant(T0 + 5_000, 'pushed', RUN_PROMPT),
  ];
}

describe('a run whose prompt is not loaded', () => {
  test('stays in order, as its own leading turn, before a later prompt', () => {
    const followUp = user(T0 + 6_000, 'follow-up');
    const turns = groupMessagesIntoTurns([
      ...runTail(),
      followUp,
      assistant(T0 + 7_000, 'reply', followUp.info.id),
    ]);

    expect(turns).toHaveLength(2);
    expect(turns[0].partial).toBe(true);
    expect(turns[0].userMessage.info.id).toBe(RUN_PROMPT);
    expect(texts(turns[0].assistantMessages)).toEqual([
      'typecheck',
      'formatting',
      'learnings',
      'commit',
      'pushed',
    ]);
    expect(turns[1].partial).toBeUndefined();
    expect(turns[1].userMessage.info.id).toBe(followUp.info.id);
    expect(texts(turns[1].assistantMessages)).toEqual(['reply']);
  });

  test('is one partial turn, in order, when no prompt is loaded at all', () => {
    const turns = groupMessagesIntoTurns(runTail());

    expect(turns).toHaveLength(1);
    expect(turns[0].partial).toBe(true);
    expect(turns[0].userMessage.info.id).toBe(RUN_PROMPT);
    expect(turns[0].userMessage.info.role).toBe('user');
    expect(turns[0].userMessage.parts).toEqual([]);
    expect(texts(turns[0].assistantMessages)).toEqual([
      'typecheck',
      'formatting',
      'learnings',
      'commit',
      'pushed',
    ]);
  });

  test('keeps its order whatever order the host handed the messages over in', () => {
    const turns = groupMessagesIntoTurns([...runTail()].reverse());
    expect(texts(turns[0].assistantMessages)).toEqual([
      'typecheck',
      'formatting',
      'learnings',
      'commit',
      'pushed',
    ]);
  });

  test('two unloaded prompts give two partial turns, in order', () => {
    const other = wireId(T0 + 2_500, 'other-prompt');
    const turns = groupMessagesIntoTurns([
      assistant(T0 + 1_000, 'a1', RUN_PROMPT),
      assistant(T0 + 2_000, 'a2', RUN_PROMPT),
      assistant(T0 + 3_000, 'b1', other),
      assistant(T0 + 4_000, 'b2', other),
    ]);

    expect(turns.map((turn) => [turn.userMessage.info.id, turn.partial])).toEqual([
      [RUN_PROMPT, true],
      [other, true],
    ]);
    expect(turns.map((turn) => texts(turn.assistantMessages))).toEqual([
      ['a1', 'a2'],
      ['b1', 'b2'],
    ]);
  });

  test('becomes the real turn under the same id once its prompt loads', () => {
    const before = groupMessagesIntoTurns(runTail());
    const prompt = {
      info: { id: RUN_PROMPT, role: 'user', time: { created: T0 } },
      parts: [{ id: 'prt_prompt', type: 'text', text: 'fix the audit 5xx' }],
    } as MessageWithPartsLike;
    const after = groupMessagesIntoTurns([prompt, ...runTail()]);

    expect(before[0].userMessage.info.id).toBe(RUN_PROMPT);
    expect(after).toHaveLength(1);
    expect(after[0].partial).toBeUndefined();
    expect(after[0].userMessage).toBe(prompt);
    expect(texts(after[0].assistantMessages)).toEqual(texts(before[0].assistantMessages));
  });

  test('the stand-in prompt is the same object on every call, so stable-turn caches hold', () => {
    const first = groupMessagesIntoTurns(runTail());
    const second = groupMessagesIntoTurns(runTail());
    expect(second[0].userMessage).toBe(first[0].userMessage);
  });
});

describe('orphans without a parent keep their contract, in order', () => {
  test('several before every prompt attach to the first turn in display order', () => {
    const prompt = user(T0 + 5_000, 'prompt');
    const turns = groupMessagesIntoTurns([
      assistant(T0 + 1_000, 'init-1'),
      assistant(T0 + 2_000, 'init-2'),
      assistant(T0 + 3_000, 'init-3'),
      prompt,
      assistant(T0 + 6_000, 'reply', prompt.info.id),
    ]);

    expect(turns).toHaveLength(1);
    expect(turns[0].partial).toBeUndefined();
    expect(texts(turns[0].assistantMessages)).toEqual(['init-1', 'init-2', 'init-3', 'reply']);
  });

  test('several with no prompt at all form one synthetic turn in display order', () => {
    const turns = groupMessagesIntoTurns([
      assistant(T0 + 1_000, 'solo-1'),
      assistant(T0 + 2_000, 'solo-2'),
      assistant(T0 + 3_000, 'solo-3'),
    ]);

    expect(turns).toHaveLength(1);
    expect(texts([turns[0].userMessage])).toEqual(['solo-1']);
    expect(texts(turns[0].assistantMessages)).toEqual(['solo-2', 'solo-3']);
  });
});
