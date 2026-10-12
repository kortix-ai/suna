// One attachment = one session using this browser: a tab group, a bridge
// socket to kortixd, and a Shim that speaks CDP over the bridge.
import { Shim, type ShimHost, type TabInfo } from './shim';
import { acquire, release } from './pool';
import { getToken } from './auth';
import { getStored, wsUrl } from './state';
import type { AttachmentRecord, Browser, TabScope } from './types';

const SCHEME = /^(https?:|file:|about:blank$)/;
const STORE = /^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)/;
export const inScopeUrl = (url: string) => SCHEME.test(url) && !STORE.test(url);

export const toTabInfo = (t: chrome.tabs.Tab): TabInfo => ({
  id: t.id!, windowId: t.windowId, url: t.url || t.pendingUrl || '', title: t.title ?? '',
  groupId: t.groupId ?? -1, active: t.active,
});

export type AttachmentEnv = {
  onBridgeOpen(a: Attachment): void;
  onEnded(a: Attachment, reason: 'stopped' | 'closed' | 'canceled_by_user' | 'error'): void;
  onGroup(a: Attachment): void;
  browser(): Browser | undefined;
  overlay(tabId: number, a: Attachment): void;
};

export class Attachment {
  groupId: number | undefined;
  paused = false;
  touched = new Set<number>();
  readonly shim: Shim;
  private ws?: WebSocket;
  private ping?: ReturnType<typeof setInterval>;
  private ended = false;
  private retries = 0;
  scope: TabScope = 'all';

  constructor(public rec: AttachmentRecord, private env: AttachmentEnv) {
    this.groupId = rec.groupId >= 0 ? rec.groupId : undefined;
    for (const id of rec.tabIds ?? []) this.touched.add(id);
    this.shim = new Shim(this.host(), (c, m) => this.send({ c, m }));
  }

  get title() { return this.rec.sessionTitle; }
  record(): AttachmentRecord { return { ...this.rec, groupId: this.groupId ?? -1, tabIds: [...this.touched] }; }

  // ─── bridge ────────────────────────────────────────────────────────────────

  async dial(): Promise<void> {
    if (this.ended) return;
    const token = await getToken();
    const { apiUrl } = await getStored();
    if (!token || !apiUrl) return this.end('error');
    const ws = new WebSocket(`${wsUrl(apiUrl, this.rec.bridgePath)}&token=${encodeURIComponent(token)}`);
    this.ws = ws;
    ws.onopen = () => {
      this.retries = 0;
      const b = this.env.browser();
      this.send({ hello: { browser: b, tabScope: b?.tabScope ?? this.scope } });
      this.ping = setInterval(() => this.send({ ping: 1 }), 20_000);
      this.env.onBridgeOpen(this);
    };
    ws.onmessage = (e) => {
      let f: any;
      try { f = JSON.parse(String(e.data)); } catch { return; }
      if (f.ping) return this.send({ pong: 1 });
      if (typeof f.c !== 'string') return;
      if (f.open) this.shim.openClient(f.c);
      else if (f.close) this.shim.closeClient(f.c);
      else if (f.m) void this.shim.handle(f.c, f.m);
    };
    ws.onclose = () => {
      clearInterval(this.ping);
      if (this.ws !== ws || this.ended) return;
      this.shim.closeAll(); // clients are gone with the bridge
      if (++this.retries > 5) return this.end('error');
      setTimeout(() => void this.dial(), Math.min(15_000, 1000 * 2 ** this.retries));
    };
  }

  private send(o: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(o));
  }

  // ─── lifecycle ─────────────────────────────────────────────────────────────

  async end(reason: 'stopped' | 'closed' | 'canceled_by_user' | 'error') {
    if (this.ended) return;
    this.ended = true;
    clearInterval(this.ping);
    const ws = this.ws;
    this.ws = undefined;
    ws?.close();
    this.shim.closeAll();
    const tabs = await chrome.tabs.query({}).catch(() => []);
    const inGroup = tabs.filter((t) => this.groupId !== undefined && t.groupId === this.groupId).map((t) => t.id!);
    for (const id of new Set([...inGroup, ...this.touched])) this.env.overlay(id, this);
    if (inGroup.length) await chrome.tabs.ungroup(inGroup as [number, ...number[]]).catch(() => {});
    // The blank tab a session started in, never used: close it, so sessions leave no clutter.
    // Pages it opened stay, so the user can read what it did.
    const blank = tabs.filter((t) => this.touched.has(t.id!) && (t.url || t.pendingUrl || 'about:blank') === 'about:blank').map((t) => t.id!);
    if (blank.length) await chrome.tabs.remove(blank).catch(() => {});
    this.env.onEnded(this, reason);
  }

  setPaused(p: boolean) {
    this.paused = p;
    void this.refreshOverlays();
  }

  async refreshOverlays() {
    const tabs = await chrome.tabs.query({});
    for (const t of tabs) if (this.owns(t.id!, t.groupId)) this.env.overlay(t.id!, this);
  }

  owns(tabId: number, groupId: number) {
    return !this.ended && ((this.groupId !== undefined && groupId === this.groupId) || this.touched.has(tabId));
  }
  get isEnded() { return this.ended; }

  // ─── tab groups ────────────────────────────────────────────────────────────

  private groupTitle() { return `Kortix · ${this.rec.sessionTitle}`.slice(0, 48); }

  /**
   * The tab belongs to this session from now on. The tab group is decoration:
   * some Chromium browsers (Arc, Dia) do not implement chrome.tabGroups, so a
   * failure here never fails the agent's command.
   */
  async addToGroup(tabId: number, windowId?: number) {
    this.touched.add(tabId);
    try {
      if (this.groupId !== undefined) {
        try {
          await chrome.tabs.group({ groupId: this.groupId, tabIds: [tabId] });
          return;
        } catch { this.groupId = undefined; } // the group is gone
      }
      this.groupId = await chrome.tabs.group({ tabIds: [tabId], ...(windowId ? { createProperties: { windowId } } : {}) });
      await chrome.tabGroups.update(this.groupId, { title: this.groupTitle(), color: 'blue', collapsed: false });
    } catch {
      this.groupId = undefined;
    }
    this.env.onGroup(this);
  }

  private async sessionWindow(): Promise<number | undefined> {
    if (this.groupId !== undefined) {
      const g = await chrome.tabGroups.get(this.groupId).catch(() => undefined);
      if (g) return g.windowId;
    }
    const w = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => undefined);
    if (w?.id !== undefined) return w.id;
    return (await chrome.windows.create({ focused: false }))?.id;
  }

  // ─── shim host ─────────────────────────────────────────────────────────────

  private host(): ShimHost {
    const hasGroup = () => this.groupId !== undefined;
    return {
      version: () => {
        const ua = navigator.userAgent;
        return { product: `Chrome/${/Chrome\/([\d.]+)/.exec(ua)?.[1] ?? '0'}`, userAgent: ua.replace('HeadlessChrome', 'Chrome') };
      },
      listTabs: async () => (await chrome.tabs.query({})).map(toTabInfo),
      getTab: async (id) => {
        try { return toTabInfo(await chrome.tabs.get(id)); } catch { return undefined; }
      },
      inScope: (t) =>
        inScopeUrl(t.url) &&
        ((this.env.browser()?.tabScope ?? this.scope) === 'all' || this.touched.has(t.id) || (hasGroup() && t.groupId === this.groupId)),
      owns: (t) => this.touched.has(t.id) || (hasGroup() && t.groupId === this.groupId),
      createTab: async (url) => {
        const first = this.touched.size === 0;
        const windowId = await this.sessionWindow().catch(() => undefined);
        const tab = await chrome.tabs.create({ url, active: first, windowId }).catch(() => chrome.tabs.create({ url, active: first }));
        await this.addToGroup(tab.id!, tab.windowId);
        return toTabInfo(await chrome.tabs.get(tab.id!));
      },
      closeTab: (id) => chrome.tabs.remove(id),
      activateTab: async (id) => { await chrome.tabs.update(id, { active: true }); },
      getWindow: async (id) => {
        const w = await chrome.windows.get(id);
        return { windowId: id, bounds: { left: w.left, top: w.top, width: w.width, height: w.height, windowState: w.state } };
      },
      targets: async () =>
        (await chrome.debugger.getTargets())
          .filter((t) => t.type === 'page')
          .map((t) => ({ id: t.id, tabId: t.tabId, type: t.type, url: t.url, title: t.title })),
      attach: acquire,
      detach: release,
      send: (tabId, sessionId, method, params) =>
        chrome.debugger.sendCommand({ tabId, ...(sessionId ? { sessionId } : {}) }, method, (params ?? {}) as Record<string, unknown>),
      paused: () => this.paused,
      // Bounded: a tab without the overlay (a page that blocks scripts) must not stall input.
      pointer: (tabId, p) =>
        Promise.race([
          chrome.tabs.sendMessage(tabId, { kortix: 'cursor', x: p.x, y: p.y, type: p.type }).then(() => {}, () => {}),
          new Promise<void>((r) => setTimeout(r, 250)),
        ]),
      touched: (tabId) => {
        this.touched.add(tabId);
        this.env.overlay(tabId, this);
      },
    };
  }
}
