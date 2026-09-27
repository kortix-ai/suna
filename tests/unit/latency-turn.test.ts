import { describe, expect, it } from 'vitest';
import {
  findNewAssistantMessage,
  knownMessageIds,
  messageGenerationMs,
  type OcMessage,
} from '../src/core/latency-turn';

/**
 * Correlating a `prompt_async` call to the assistant reply it produced.
 * The turn-latency spec (PR #7840)'s own prompt ("Reply with exactly: OK") is
 * identical on every iteration, so the harness cannot tell turns apart by
 * text — it diffs the known message-id set instead, matching the convention
 * `tests/src/flows/session-thread-reliability.flow.ts` already uses for
 * OpenCode's wire shape (`info.id`/`info.role`/`info.time.{created,completed}`).
 */

const user = (id: string): OcMessage => ({ info: { id, role: 'user' } });
const assistant = (id: string, time?: { created?: number; completed?: number }): OcMessage => ({
  info: { id, role: 'assistant', time },
});

describe('knownMessageIds', () => {
  it('collects every message id, any role', () => {
    expect(knownMessageIds([user('u1'), assistant('a1')])).toEqual(new Set(['u1', 'a1']));
  });

  it('skips a message with no id instead of throwing', () => {
    expect(knownMessageIds([{ info: { role: 'user' } }, assistant('a1')])).toEqual(
      new Set(['a1']),
    );
  });
});

describe('findNewAssistantMessage', () => {
  it('returns the first assistant message whose id is not already known', () => {
    const known = new Set(['u1']);
    const messages = [user('u1'), user('u2'), assistant('a1')];
    expect(findNewAssistantMessage(messages, known)?.info?.id).toBe('a1');
  });

  it('ignores a NEW user message — only a NEW assistant message counts', () => {
    const known = new Set(['u1']);
    expect(findNewAssistantMessage([user('u1'), user('u2')], known)).toBeNull();
  });

  it('ignores an assistant message that was already known before this turn was sent', () => {
    const known = new Set(['u1', 'a-old']);
    expect(findNewAssistantMessage([user('u1'), assistant('a-old')], known)).toBeNull();
  });

  it('returns null on an empty list', () => {
    expect(findNewAssistantMessage([], new Set())).toBeNull();
  });
});

describe('messageGenerationMs', () => {
  it('is completed - created when both are set — the server clock delta, immune to client/box clock skew', () => {
    expect(messageGenerationMs(assistant('a1', { created: 1000, completed: 4210 }))).toBe(3210);
  });

  it('is null while still generating (no completed timestamp yet)', () => {
    expect(messageGenerationMs(assistant('a1', { created: 1000 }))).toBeNull();
  });

  it('is null when time is missing entirely', () => {
    expect(messageGenerationMs(assistant('a1'))).toBeNull();
  });

  it('is null for a non-positive duration — a clock anomaly, not a real 0ms generation', () => {
    expect(messageGenerationMs(assistant('a1', { created: 1000, completed: 1000 }))).toBeNull();
    expect(messageGenerationMs(assistant('a1', { created: 1000, completed: 900 }))).toBeNull();
  });
});
