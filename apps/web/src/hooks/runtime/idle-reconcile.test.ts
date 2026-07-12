import { describe, expect, test } from 'bun:test';

import { hasUnsettledToolPart, type IdleReconcilePart as Part } from './idle-reconcile';

// Minimal tool-part factory — only the fields the predicate reads.
function toolPart(
  id: string,
  state: {
    status: string;
    input?: Record<string, unknown>;
    raw?: unknown;
    output?: string;
  },
): Part {
  return { id, type: 'tool', tool: 'show', state } as unknown as Part;
}

const msgs = [{ id: 'm1' }];

describe('hasUnsettledToolPart', () => {
  test('running tool part → unsettled', () => {
    const parts = { m1: [toolPart('p1', { status: 'running', input: { a: 1 } })] };
    expect(hasUnsettledToolPart(msgs, parts)).toBe(true);
  });

  test('pending WITH input → unsettled (the stuck-spinner bug)', () => {
    const parts = { m1: [toolPart('p1', { status: 'pending', input: { url: 'x' } })] };
    expect(hasUnsettledToolPart(msgs, parts)).toBe(true);
  });

  test('pending with raw but empty input → unsettled', () => {
    const parts = { m1: [toolPart('p1', { status: 'pending', input: {}, raw: '{partial' })] };
    expect(hasUnsettledToolPart(msgs, parts)).toBe(true);
  });

  test('stale-pending (empty input, no raw) → settled (excluded)', () => {
    const parts = { m1: [toolPart('p1', { status: 'pending', input: {} })] };
    expect(hasUnsettledToolPart(msgs, parts)).toBe(false);
  });

  test('completed tool part → settled (the happy path: no refetch)', () => {
    const parts = {
      m1: [toolPart('p1', { status: 'completed', input: { url: 'x' }, output: 'done' })],
    };
    expect(hasUnsettledToolPart(msgs, parts)).toBe(false);
  });

  test('non-tool parts are ignored', () => {
    const textPart = { id: 'p1', type: 'text', text: 'hello' } as unknown as Part;
    expect(hasUnsettledToolPart(msgs, { m1: [textPart] })).toBe(false);
  });

  test('message with no parts → settled', () => {
    expect(hasUnsettledToolPart(msgs, {})).toBe(false);
  });

  test('empty message list → settled even if stray parts exist', () => {
    const parts = { m1: [toolPart('p1', { status: 'running' })] };
    expect(hasUnsettledToolPart([], parts)).toBe(false);
  });

  test('mixed across messages: one completed + one running → unsettled', () => {
    const messages = [{ id: 'm1' }, { id: 'm2' }];
    const parts = {
      m1: [toolPart('p1', { status: 'completed', input: { a: 1 }, output: 'ok' })],
      m2: [toolPart('p2', { status: 'running', input: { b: 2 } })],
    };
    expect(hasUnsettledToolPart(messages, parts)).toBe(true);
  });

  test('all completed across messages → settled', () => {
    const messages = [{ id: 'm1' }, { id: 'm2' }];
    const parts = {
      m1: [toolPart('p1', { status: 'completed', input: { a: 1 }, output: 'ok' })],
      m2: [toolPart('p2', { status: 'completed', input: { b: 2 }, output: 'ok' })],
    };
    expect(hasUnsettledToolPart(messages, parts)).toBe(false);
  });
});
