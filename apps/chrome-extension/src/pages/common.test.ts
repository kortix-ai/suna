import { describe, expect, test } from 'bun:test';
import { accountsDiffer, arrowTarget, identityFrom, needsSession, PanelHandoff } from './common';

const frame = {} as Window;
const ok = { origin: 'https://kortix.com', source: frame, data: { type: 'kortix.identity', userId: 'u1', email: 'a@x.test' } };

describe('panel identity', () => {
  test('accepts the web app origin from the panel frame', () => {
    expect(identityFrom(ok, 'https://kortix.com', frame)).toEqual({ userId: 'u1', email: 'a@x.test' });
  });
  test('rejects another origin, another source, or another message', () => {
    expect(identityFrom({ ...ok, origin: 'https://evil.test' }, 'https://kortix.com', frame)).toBeUndefined();
    expect(identityFrom({ ...ok, source: {} }, 'https://kortix.com', frame)).toBeUndefined();
    expect(identityFrom({ ...ok, data: { type: 'x', userId: 'u1' } }, 'https://kortix.com', frame)).toBeUndefined();
    expect(identityFrom({ ...ok, data: { type: 'kortix.identity', userId: 5 } }, 'https://kortix.com', frame)).toBeUndefined();
  });
  test('accounts differ only when both ids are known and unequal', () => {
    expect(accountsDiffer({ userId: 'a', email: '' }, { userId: 'b', email: '' })).toBe(true);
    expect(accountsDiffer({ userId: 'a', email: '' }, { userId: 'a', email: '' })).toBe(false);
    expect(accountsDiffer(undefined, { userId: 'b', email: '' })).toBe(false);
  });
});

describe('panel sign-in handshake', () => {
  const need = { origin: 'https://kortix.com', source: frame, data: { type: 'kortix.panel.needSession' } };
  test('needSession counts only from the web origin, sent by the panel frame', () => {
    expect(needsSession(need, 'https://kortix.com', frame)).toBe(true);
    expect(needsSession({ ...need, origin: 'https://evil.test' }, 'https://kortix.com', frame)).toBe(false);
    expect(needsSession({ ...need, origin: 'https://kortix.com.evil.test' }, 'https://kortix.com', frame)).toBe(false);
    expect(needsSession({ ...need, source: {} }, 'https://kortix.com', frame)).toBe(false);
    expect(needsSession(need, 'https://kortix.com', null)).toBe(false);
    expect(needsSession({ ...need, data: { type: 'kortix.identity' } }, 'https://kortix.com', frame)).toBe(false);
    expect(needsSession({ ...need, data: null }, 'https://kortix.com', frame)).toBe(false);
  });
  test('a signed-out panel (no web URL yet) ignores every message', () => {
    expect(needsSession(need, '', frame)).toBe(false);
    expect(identityFrom({ ...ok }, '', frame)).toBeUndefined();
  });
  test('one request per needSession; a second one while busy is dropped', async () => {
    let calls = 0;
    const sent: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const h = new PanelHandoff(async () => { calls++; await gate; return 'H1'; }, (t) => sent.push(t));
    const first = h.onNeedSession();
    await h.onNeedSession();
    release();
    await first;
    expect(calls).toBe(1);
    expect(sent).toEqual(['H1']);
  });
  test('at most one retry per navigation, then it stops; reset allows a new attempt', async () => {
    let calls = 0;
    const h = new PanelHandoff(async () => { calls++; throw new Error('offline'); }, () => {});
    for (let i = 0; i < 5; i++) await h.onNeedSession();
    expect(calls).toBe(2);
    h.reset();
    await h.onNeedSession();
    expect(calls).toBe(3);
  });
  test('a failed request delivers nothing', async () => {
    const sent: string[] = [];
    await new PanelHandoff(async () => { throw new Error('403'); }, (t) => sent.push(t)).onNeedSession();
    expect(sent).toEqual([]);
  });
});

describe('segmented control keys', () => {
  test('arrows wrap around; other keys are ignored', () => {
    expect(arrowTarget('ArrowRight', 0, 3)).toBe(1);
    expect(arrowTarget('ArrowRight', 2, 3)).toBe(0);
    expect(arrowTarget('ArrowLeft', 0, 3)).toBe(2);
    expect(arrowTarget('ArrowDown', -1, 2)).toBe(1);
    expect(arrowTarget('Enter', 0, 3)).toBeUndefined();
  });
});
