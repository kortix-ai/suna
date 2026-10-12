import { beforeEach, describe, expect, test } from 'bun:test';
import { Shim, type ShimHost, type TabInfo } from './shim';

type Out = Record<string, any>;
function fake() {
  const tabs = new Map<number, TabInfo>();
  const sends: { tabId: number; child?: string; method: string; params: any }[] = [];
  const log = { attached: [] as number[], detached: [] as number[], pointer: [] as any[], activated: [] as number[], closed: [] as number[] };
  let next = 1;
  let scope: 'own' | 'all' = 'own';
  let paused = false;
  const add = (url: string, groupId = 7): TabInfo => {
    const t = { id: next++, windowId: 1, url, title: `t${next}`, groupId };
    tabs.set(t.id, t);
    return t;
  };
  const host: ShimHost = {
    version: () => ({ product: 'Chrome/130.0.0.0', userAgent: 'UA' }),
    listTabs: async () => [...tabs.values()],
    getTab: async (id) => tabs.get(id),
    inScope: (t) => /^(https?:|about:blank)/.test(t.url) && (scope === 'all' || t.groupId === 7),
    createTab: async (url) => add(url),
    closeTab: async (id) => { log.closed.push(id); },
    activateTab: async (id) => { log.activated.push(id); },
    getWindow: async (windowId) => ({ windowId, bounds: { width: 800 } }),
    targets: async () => [...tabs.values()].map((t) => ({ id: `T${t.id}`, tabId: t.id, type: 'page', url: t.url, title: t.title })),
    attach: async (id) => { log.attached.push(id); },
    detach: async (id) => { log.detached.push(id); },
    send: async (tabId, child, method, params) => {
      sends.push({ tabId, child, method, params });
      if (method === 'Runtime.evaluate' && (params as any)?.expression === 'boom') throw new Error('Cannot find context');
      return { ok: method };
    },
    paused: () => paused,
    pointer: async (_t, p) => void log.pointer.push(p),
    touched: () => {},
  };
  const out: Record<string, Out[]> = {};
  const shim = new Shim(host, (c, m) => (out[c] ??= []).push(m));
  const call = async (c: string, method: string, params?: any, sessionId?: string) => {
    const id = Math.floor(Math.random() * 1e9);
    await shim.handle(c, { id, method, params, sessionId });
    return out[c]!.find((m) => m.id === id)!;
  };
  return { shim, add, tabs, sends, log, out, call, setScope: (s: 'own' | 'all') => (scope = s), setPaused: (p: boolean) => (paused = p) };
}

let f: ReturnType<typeof fake>;
beforeEach(() => { f = fake(); f.shim.openClient('1'); });

describe('browser-level methods', () => {
  test('Browser.getVersion', async () => {
    const r = await f.call('1', 'Browser.getVersion');
    expect(r.result).toEqual({ protocolVersion: '1.3', product: 'Chrome/130.0.0.0', revision: '', userAgent: 'UA', jsVersion: '' });
  });
  test('Target.getTargets lists only in-scope tabs', async () => {
    f.add('https://a.test');
    f.add('https://other.test', -1);
    f.add('chrome://settings');
    const r = await f.call('1', 'Target.getTargets');
    expect(r.result.targetInfos.map((t: any) => t.url)).toEqual(['https://a.test']);
    expect(r.result.targetInfos[0]).toMatchObject({ type: 'page', targetId: 'T1', attached: false });
  });
  test('Target.getTargets with no in-scope tab creates about:blank', async () => {
    const r = await f.call('1', 'Target.getTargets');
    expect(r.result.targetInfos).toHaveLength(1);
    expect(r.result.targetInfos[0].url).toBe('about:blank');
  });
  test('scope all includes tabs outside the group, never chrome://', async () => {
    f.add('https://other.test', -1);
    f.add('chrome://settings', -1);
    f.setScope('all');
    const r = await f.call('1', 'Target.getTargets');
    expect(r.result.targetInfos.map((t: any) => t.url)).toEqual(['https://other.test']);
  });
  test('Target.createTarget returns the new targetId', async () => {
    const r = await f.call('1', 'Target.createTarget', { url: 'https://new.test' });
    expect(r.result.targetId).toBe('T1');
    expect(f.tabs.get(1)!.url).toBe('https://new.test');
  });
  test('Target.closeTarget / activateTarget', async () => {
    f.add('https://a.test');
    expect((await f.call('1', 'Target.closeTarget', { targetId: 'T1' })).result).toEqual({ success: true });
    expect((await f.call('1', 'Target.activateTarget', { targetId: 'T1' })).result).toEqual({});
    expect(f.log.closed).toEqual([1]);
    expect(f.log.activated).toEqual([1]);
  });
  test('closeTarget refuses an out-of-scope target', async () => {
    f.add('https://x.test', -1);
    const r = await f.call('1', 'Target.closeTarget', { targetId: 'T1' });
    expect(r.error.code).toBe(-32602);
    expect(f.log.closed).toEqual([]);
  });
  test('Browser.getWindowForTarget', async () => {
    f.add('https://a.test');
    const r = await f.call('1', 'Browser.getWindowForTarget', { targetId: 'T1' });
    expect(r.result).toEqual({ windowId: 1, bounds: { width: 800 } });
  });
  test('no-op methods never touch the browser', async () => {
    for (const m of ['Browser.setContentsSize', 'Browser.setDownloadBehavior', 'Browser.close']) {
      expect((await f.call('1', m, {})).result).toEqual({});
    }
    expect(f.sends).toHaveLength(0);
  });
  test('Target.getTargetInfo without targetId is the browser target', async () => {
    const r = await f.call('1', 'Target.getTargetInfo');
    expect(r.result.targetInfo.type).toBe('browser');
  });
  test('unknown method -> -32601', async () => {
    const r = await f.call('1', 'Fetch.enable');
    expect(r.error).toEqual({ code: -32601, message: 'Fetch.enable is not available in Kortix Browser' });
  });
});

describe('discovery events', () => {
  test('setDiscoverTargets emits targetCreated now, then for new tabs, info changes and destroy', async () => {
    const t = f.add('https://a.test');
    await f.call('1', 'Target.setDiscoverTargets', { discover: true });
    await Bun.sleep(10);
    expect(f.out['1']!.filter((m) => m.method === 'Target.targetCreated').map((m) => m.params.targetInfo.url)).toEqual(['https://a.test']);
    const b = f.add('https://b.test');
    f.shim.onTabCreated(b);
    await Bun.sleep(10);
    t.url = 'https://a.test/2';
    f.shim.onTabUpdated(t);
    await Bun.sleep(10);
    f.tabs.delete(b.id);
    f.shim.onTabRemoved(b.id);
    const ms = f.out['1']!.map((m) => m.method).filter(Boolean);
    expect(ms).toEqual(['Target.targetCreated', 'Target.targetCreated', 'Target.targetInfoChanged', 'Target.targetDestroyed']);
    expect(f.out['1']!.at(-1)!.params.targetId).toBe('T2');
  });
  test('no events without discover', async () => {
    f.shim.onTabCreated(f.add('https://a.test'));
    await Bun.sleep(10);
    expect(f.out['1']).toBeUndefined();
  });
  test('a tab leaving scope is destroyed', async () => {
    const t = f.add('https://a.test');
    await f.call('1', 'Target.setDiscoverTargets', { discover: true });
    await Bun.sleep(10);
    t.groupId = -1;
    f.shim.onTabUpdated(t);
    expect(f.out['1']!.at(-1)!.method).toBe('Target.targetDestroyed');
  });
});

describe('sessions', () => {
  async function attach(c = '1', targetId = 'T1') {
    const r = await f.call(c, 'Target.attachToTarget', { targetId, flatten: true });
    return r.result.sessionId as string;
  }
  test('attachToTarget attaches once per tab, mints a session, emits attachedToTarget', async () => {
    f.add('https://a.test');
    const sid = await attach();
    expect(f.log.attached).toEqual([1]);
    const ev = f.out['1']!.find((m) => m.method === 'Target.attachedToTarget')!;
    expect(ev.params.sessionId).toBe(sid);
    expect(ev.params.targetInfo).toMatchObject({ targetId: 'T1', attached: true });
  });
  test('two clients share one debugger attach; detached when the last leaves', async () => {
    f.add('https://a.test');
    f.shim.openClient('2');
    const s1 = await attach('1');
    const s2 = await attach('2');
    expect(s1).not.toBe(s2);
    expect(f.log.attached).toEqual([1]);
    f.shim.closeClient('1');
    expect(f.log.detached).toEqual([]);
    f.shim.closeClient('2');
    expect(f.log.detached).toEqual([1]);
  });
  test('session commands go to the tab, the reply carries the sessionId', async () => {
    f.add('https://a.test');
    const sid = await attach();
    const r = await f.call('1', 'Runtime.evaluate', { expression: '1+1' }, sid);
    expect(r.result).toEqual({ ok: 'Runtime.evaluate' });
    expect(r.sessionId).toBe(sid);
    expect(f.sends.at(-1)).toMatchObject({ tabId: 1, child: undefined, method: 'Runtime.evaluate' });
  });
  test('a chrome error becomes a CDP error', async () => {
    f.add('https://a.test');
    const sid = await attach();
    const r = await f.call('1', 'Runtime.evaluate', { expression: 'boom' }, sid);
    expect(r.error).toEqual({ code: -32000, message: 'Cannot find context' });
  });
  test('unknown session -> -32001', async () => {
    const r = await f.call('1', 'Runtime.enable', {}, 'nope');
    expect(r.error.code).toBe(-32001);
  });
  test('every agent-browser session method passes through', async () => {
    f.add('https://a.test');
    const sid = await attach();
    const methods = ['Target.setAutoAttach', 'Runtime.runIfWaitingForDebugger', 'Runtime.enable', 'Runtime.callFunctionOn', 'Page.enable',
      'Page.navigate', 'Network.enable', 'DOM.enable', 'DOM.resolveNode', 'DOM.getBoxModel', 'DOM.scrollIntoViewIfNeeded',
      'Accessibility.enable', 'Accessibility.getFullAXTree', 'Input.dispatchKeyEvent', 'Input.insertText', 'Emulation.setDeviceMetricsOverride'];
    for (const m of methods) expect((await f.call('1', m, {}, sid)).result).toEqual({ ok: m });
  });
  test('child sessions: learned from attachedToTarget, commands routed with sessionId, events keep their id', async () => {
    f.add('https://a.test');
    const sid = await attach();
    f.shim.onDebuggerEvent(1, undefined, 'Target.attachedToTarget', { sessionId: 'CHILD', targetInfo: {} });
    expect(f.out['1']!.at(-1)).toMatchObject({ method: 'Target.attachedToTarget', sessionId: sid });
    const r = await f.call('1', 'Runtime.runIfWaitingForDebugger', {}, 'CHILD');
    expect(r.sessionId).toBe('CHILD');
    expect(f.sends.at(-1)).toMatchObject({ tabId: 1, child: 'CHILD' });
    f.shim.onDebuggerEvent(1, 'CHILD', 'Runtime.executionContextCreated', { context: {} });
    expect(f.out['1']!.at(-1)).toMatchObject({ method: 'Runtime.executionContextCreated', sessionId: 'CHILD' });
    f.shim.onDebuggerEvent(1, undefined, 'Target.detachedFromTarget', { sessionId: 'CHILD' });
    expect((await f.call('1', 'Runtime.enable', {}, 'CHILD')).error.code).toBe(-32001);
  });
  test('event fan-out: every client session on the tab gets the event, others do not', async () => {
    f.add('https://a.test');
    f.add('https://b.test');
    f.shim.openClient('2');
    const s1 = await attach('1', 'T1');
    const s2 = await attach('2', 'T1');
    const s3 = await attach('2', 'T2');
    f.shim.onDebuggerEvent(1, undefined, 'Page.loadEventFired', { timestamp: 1 });
    const got = (c: string) => f.out[c]!.filter((m) => m.method === 'Page.loadEventFired').map((m) => m.sessionId);
    expect(got('1')).toEqual([s1]);
    expect(got('2')).toEqual([s2]);
    expect(got('2')).not.toContain(s3);
  });
  test('detachFromTarget drops the session', async () => {
    f.add('https://a.test');
    const sid = await attach();
    expect((await f.call('1', 'Target.detachFromTarget', { sessionId: sid })).result).toEqual({});
    expect(f.log.detached).toEqual([1]);
    expect((await f.call('1', 'Runtime.enable', {}, sid)).error.code).toBe(-32001);
  });
  test('tab removed: detachedFromTarget + targetDestroyed, sessions gone', async () => {
    f.add('https://a.test');
    await f.call('1', 'Target.setDiscoverTargets', { discover: true });
    await Bun.sleep(10);
    const sid = await attach();
    f.tabs.delete(1);
    f.shim.onTabRemoved(1);
    const ms = f.out['1']!.map((m) => m.method);
    expect(ms).toContain('Target.detachedFromTarget');
    expect(ms.at(-1)).toBe('Target.targetDestroyed');
    expect((await f.call('1', 'Runtime.enable', {}, sid)).error.code).toBe(-32001);
  });
  test('debugger detach (DevTools opened) drops sessions only', async () => {
    f.add('https://a.test');
    const sid = await attach();
    f.shim.onDebuggerDetach(1);
    expect(f.out['1']!.at(-1)).toMatchObject({ method: 'Target.detachedFromTarget', params: { sessionId: sid } });
  });
  test('attachToTarget refuses a tab outside the scope', async () => {
    f.add('https://x.test', -1);
    expect((await f.call('1', 'Target.attachToTarget', { targetId: 'T1' })).error.code).toBe(-32602);
    expect(f.log.attached).toEqual([]);
  });
});

describe('visible state hooks', () => {
  test('mouse events reach the overlay and the page', async () => {
    f.add('https://a.test');
    const sid = (await f.call('1', 'Target.attachToTarget', { targetId: 'T1' })).result.sessionId;
    await f.call('1', 'Input.dispatchMouseEvent', { type: 'mousePressed', x: 10, y: 20 }, sid);
    expect(f.log.pointer).toEqual([{ type: 'mousePressed', x: 10, y: 20 }]);
    expect(f.sends.at(-1)!.method).toBe('Input.dispatchMouseEvent');
  });
  test('screenshot activates the tab first', async () => {
    f.add('https://a.test');
    const sid = (await f.call('1', 'Target.attachToTarget', { targetId: 'T1' })).result.sessionId;
    await f.call('1', 'Page.captureScreenshot', {}, sid);
    expect(f.log.activated).toEqual([1]);
  });
  test('pause rejects Input.* but not other commands', async () => {
    f.add('https://a.test');
    const sid = (await f.call('1', 'Target.attachToTarget', { targetId: 'T1' })).result.sessionId;
    f.setPaused(true);
    for (const m of ['Input.dispatchMouseEvent', 'Input.dispatchKeyEvent', 'Input.insertText']) {
      const r = await f.call('1', m, {}, sid);
      expect(r.error).toEqual({ code: -32000, message: 'The user took over this tab. Wait for them, then retry.' });
    }
    expect((await f.call('1', 'Runtime.evaluate', {}, sid)).result).toEqual({ ok: 'Runtime.evaluate' });
    expect(f.sends.some((s) => s.method.startsWith('Input.'))).toBe(false);
    f.setPaused(false);
    expect((await f.call('1', 'Input.insertText', {}, sid)).result).toEqual({ ok: 'Input.insertText' });
  });
  test('closeAll releases every tab', async () => {
    f.add('https://a.test');
    await f.call('1', 'Target.attachToTarget', { targetId: 'T1' });
    f.shim.closeAll();
    expect(f.log.detached).toEqual([1]);
  });
});
