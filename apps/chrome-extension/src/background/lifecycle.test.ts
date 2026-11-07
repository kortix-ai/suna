// Worker-restart and control-socket lifecycles, driven through fake chrome + WebSocket globals.
import { afterEach, beforeEach, expect, jest, test } from 'bun:test';

class FakeWs {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  static all: FakeWs[] = [];
  readyState = FakeWs.CONNECTING;
  sent: string[] = [];
  onopen?: () => void;
  onmessage?: (e: { data: string }) => void;
  onclose?: (e: { code: number }) => void;
  constructor(public url: string) { FakeWs.all.push(this); }
  send(s: string) { this.sent.push(s); }
  open() { this.readyState = FakeWs.OPEN; this.onopen?.(); }
  close(code = 1005) {
    if (this.readyState === FakeWs.CLOSED) return;
    this.readyState = FakeWs.CLOSED;
    this.onclose?.({ code });
  }
}

const local: Record<string, unknown> = {};
const session: Record<string, unknown> = {};
const area = (m: Record<string, unknown>) => ({
  get: async (k: string | null) => (k === null ? { ...m } : { [k]: m[k] }),
  set: async (p: Record<string, unknown>) => void Object.assign(m, p),
  remove: async (ks: string[]) => ks.forEach((k) => delete m[k]),
});
const noop = async () => {};
(globalThis as any).WebSocket = FakeWs;
(globalThis as any).navigator ??= {};
(globalThis as any).chrome = {
  storage: { local: area(local), session: area(session) },
  runtime: { getManifest: () => ({ version: '1.0.0' }) },
  tabs: { query: async () => [], sendMessage: noop, ungroup: noop, remove: noop },
  scripting: { executeScript: noop },
  action: { setBadgeText: noop, setBadgeBackgroundColor: noop, setTitle: noop },
};

const { Hub } = await import('./hub');
const { Control, AUTH_TIMEOUT_MS } = await import('./control');

beforeEach(() => {
  FakeWs.all = [];
  for (const k of Object.keys(session)) delete session[k];
  Object.assign(local, { apiUrl: 'http://localhost:8008', token: 'tok', expiresAt: Date.now() + 3_600_000 });
});
afterEach(() => jest.useRealTimers());

const frame = { type: 'attach' as const, attachmentId: 'a1', sessionId: 's1', sessionTitle: 'T', projectId: 'p1',
  projectName: 'P', bridgePath: '/v1/chrome/bridge?x=1', ticket: 't', consent: false };

test('a paused attachment stays paused after the worker restarts', async () => {
  const before = new Hub(() => {});
  await before.onAttach(frame);
  before.all.get('a1')!.setPaused(true);
  await Bun.sleep(0);

  const after = new Hub(() => {}); // a new service worker: memory is gone, session storage is not
  await after.restore();
  expect(after.all.get('a1')!.paused).toBe(true);
});

test('resume is persisted too', async () => {
  const before = new Hub(() => {});
  await before.onAttach(frame);
  const a = before.all.get('a1')!;
  a.setPaused(true);
  a.setPaused(false);
  await Bun.sleep(0);
  const after = new Hub(() => {});
  await after.restore();
  expect(after.all.get('a1')!.paused).toBe(false);
});

test('a control socket that opens but never authenticates is closed and re-dialed', async () => {
  jest.useFakeTimers();
  const states: boolean[] = [];
  const c = new Control({ attach() {}, detach() {}, chrome() {}, authed() {}, disconnected() {}, state: (s) => states.push(s) });
  await c.connect();
  expect(FakeWs.all.length).toBe(1);
  FakeWs.all[0]!.open();
  await Promise.resolve(); await Promise.resolve();
  expect(FakeWs.all[0]!.sent.some((s) => JSON.parse(s).type === 'auth')).toBe(true);

  jest.advanceTimersByTime(AUTH_TIMEOUT_MS + 1);
  expect(FakeWs.all[0]!.readyState).toBe(FakeWs.CLOSED);
  await Promise.resolve(); await Promise.resolve();
  jest.advanceTimersByTime(30_000);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(FakeWs.all.length).toBe(2); // the retry dialed a fresh socket
  expect(c.online).toBe(false);
});

test('a control socket that authenticates in time stays open', async () => {
  jest.useFakeTimers();
  const c = new Control({ attach() {}, detach() {}, chrome() {}, authed() {}, disconnected() {}, state() {} });
  await c.connect();
  const ws = FakeWs.all[0]!;
  ws.open();
  await Promise.resolve(); await Promise.resolve();
  ws.onmessage!({ data: JSON.stringify({ type: 'auth_ok', chrome: { id: 'c1' }, webUrl: 'http://localhost:3000' }) });
  jest.advanceTimersByTime(AUTH_TIMEOUT_MS * 3);
  expect(ws.readyState).toBe(FakeWs.OPEN);
  expect(c.online).toBe(true);
  c.stop();
});
