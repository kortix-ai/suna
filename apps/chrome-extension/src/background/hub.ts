// Owns every active attachment: starts them from `attach` frames, runs the
// consent window, persists them for worker restarts, fans Chrome events out.
import { Attachment, toTabInfo, type AttachmentEnv } from './attachment';
import { forget } from './pool';
import { getStored } from './state';
import { BRAND_BLUE, OFFLINE_GREY, type AttachFrame, type AttachmentRecord, type ChromeConnection } from './types';

type Reason = 'stopped' | 'closed' | 'canceled_by_user' | 'error';
type Pending = { frame: AttachFrame; windowId?: number; decided: boolean };

export class Hub {
  readonly all = new Map<string, Attachment>();
  private pending = new Map<string, Pending>();
  chrome?: ChromeConnection;
  /** Signed in, but the control socket is down. The toolbar badge says so. */
  offline = false;

  constructor(private send: (frame: Record<string, unknown>) => void) {}

  private env: AttachmentEnv = {
    chrome: () => this.chrome,
    onBridgeOpen: (a) => this.send({ type: 'attached', attachmentId: a.rec.attachmentId }),
    onGroup: () => void this.persist(),
    onEnded: (a, reason) => {
      this.all.delete(a.rec.attachmentId);
      this.send({ type: 'detached', attachmentId: a.rec.attachmentId, reason });
      void this.persist();
    },
    overlay: (tabId, a) => {
      const msg = { kortix: 'overlay', on: !a.isEnded, paused: a.paused, title: a.title };
      const send = () => chrome.tabs.sendMessage(tabId, msg).catch(() => {});
      if (a.isEnded) return void send();
      chrome.scripting.executeScript({ target: { tabId }, files: ['overlay.js'] }).then(send, () => {});
    },
  };

  // ─── attach / detach ───────────────────────────────────────────────────────

  async onAttach(frame: AttachFrame) {
    const id = frame.attachmentId;
    if (this.all.has(id) || this.pending.has(id)) return;
    if (!frame.consent) return this.start(frame);
    const p: Pending = { frame, decided: false };
    this.pending.set(id, p);
    const w = await chrome.windows.create({
      type: 'popup', width: 420, height: 400, focused: true,
      url: chrome.runtime.getURL(`consent.html?id=${encodeURIComponent(id)}`),
    });
    p.windowId = w?.id;
  }

  consentInfo(id: string) {
    const f = this.pending.get(id)?.frame;
    return f && { sessionTitle: f.sessionTitle, projectName: f.projectName, chrome: this.chrome?.name ?? 'This browser' };
  }

  decide(id: string, decision: 'session' | 'project' | 'deny') {
    const p = this.pending.get(id);
    if (!p || p.decided) return;
    p.decided = true;
    this.pending.delete(id);
    this.send({ type: 'consent', attachmentId: id, decision });
    if (p.windowId !== undefined) void chrome.windows.remove(p.windowId).catch(() => {});
    if (decision !== 'deny') void this.start(p.frame);
  }

  /** The consent window was closed without a choice. */
  onWindowRemoved(windowId: number) {
    for (const [id, p] of this.pending) if (p.windowId === windowId) this.decide(id, 'deny');
  }

  private async start(frame: AttachFrame) {
    const { type: _t, consent: _c, ticket: _k, ...rest } = frame;
    const a = new Attachment({ ...rest, groupId: -1 }, this.env);
    this.all.set(frame.attachmentId, a);
    await this.persist();
    const handed = await this.takeHanded(frame.sessionId);
    if (handed !== undefined) await a.addToGroup(handed);
    await a.dial();
  }

  /**
   * A side panel Act send names its tab before the session attaches. The tab joins the
   * session's group when it does. Kept in session storage: the worker can restart meanwhile.
   */
  async useTab(sessionId: string, tabId: number) {
    const a = [...this.all.values()].find((x) => x.rec.sessionId === sessionId && !x.isEnded);
    if (a) return a.addToGroup(tabId);
    const { handedTabs = {} } = (await chrome.storage.session.get('handedTabs')) as { handedTabs?: Record<string, number> };
    await chrome.storage.session.set({ handedTabs: { ...handedTabs, [sessionId]: tabId } });
  }

  private async takeHanded(sessionId: string): Promise<number | undefined> {
    const { handedTabs } = (await chrome.storage.session.get('handedTabs')) as { handedTabs?: Record<string, number> };
    const tabId = handedTabs?.[sessionId];
    if (tabId === undefined) return undefined;
    const { [sessionId]: _taken, ...rest } = handedTabs!;
    await chrome.storage.session.set({ handedTabs: rest });
    return (await chrome.tabs.get(tabId).catch(() => undefined)) ? tabId : undefined;
  }

  async restore() {
    const { attachments } = (await chrome.storage.session.get('attachments')) as { attachments?: AttachmentRecord[] };
    for (const rec of attachments ?? []) {
      if (this.all.has(rec.attachmentId)) continue;
      const a = new Attachment(rec, this.env);
      this.all.set(rec.attachmentId, a);
      void a.dial();
    }
    void this.badge();
  }

  onDetachFrame(id: string, reason: Reason = 'closed') {
    return this.all.get(id)?.end(reason);
  }
  endAll(reason: Reason) {
    return Promise.all([...this.all.values()].map((a) => a.end(reason)));
  }

  private async persist() {
    await chrome.storage.session.set({ attachments: [...this.all.values()].map((a) => a.record()) });
    await this.badge();
  }

  /** Blue count while agents work (agent state), grey "!" when offline, else clear. */
  async badge() {
    const n = this.all.size;
    const text = n ? String(n) : this.offline ? '!' : '';
    await chrome.action.setBadgeText({ text });
    await chrome.action.setBadgeBackgroundColor({ color: n ? BRAND_BLUE : OFFLINE_GREY });
    await chrome.action.setTitle({ title: this.offline && !n ? 'Kortix (offline)' : 'Kortix' });
  }

  // ─── Chrome events ─────────────────────────────────────────────────────────

  onDebuggerEvent(src: chrome.debugger.DebuggerSession, method: string, params: unknown) {
    if (src.tabId === undefined) return;
    for (const a of this.all.values()) a.shim.onDebuggerEvent(src.tabId, src.sessionId, method, params);
  }

  onDebuggerDetach(src: chrome.debugger.Debuggee, reason: string) {
    if (reason === 'canceled_by_user') return void this.endAll('canceled_by_user');
    if (src.tabId === undefined) return;
    forget(src.tabId);
    for (const a of this.all.values()) a.shim.onDebuggerDetach(src.tabId);
  }

  async onTabCreated(tab: chrome.tabs.Tab) {
    for (const a of this.all.values()) {
      // A tab opened from a session tab (a link with target=_blank) joins the session.
      if (tab.openerTabId !== undefined && !a.touched.has(tab.id!)) {
        const opener = await chrome.tabs.get(tab.openerTabId).catch(() => undefined);
        if (opener && a.owns(opener.id!, opener.groupId ?? -1)) await a.addToGroup(tab.id!).catch(() => {});
      }
      a.shim.onTabCreated(toTabInfo(await chrome.tabs.get(tab.id!).catch(() => tab)));
    }
  }

  onTabUpdated(tabId: number, change: chrome.tabs.OnUpdatedInfo, tab: chrome.tabs.Tab) {
    for (const a of this.all.values()) {
      if (change.url || change.title || change.groupId !== undefined || change.status === 'complete') {
        a.shim.onTabUpdated(toTabInfo(tab));
      }
      if ((change.status === 'complete' || change.groupId !== undefined) && a.owns(tabId, tab.groupId)) {
        this.env.overlay(tabId, a);
      }
    }
  }

  onTabRemoved(tabId: number) {
    for (const a of this.all.values()) {
      a.shim.onTabRemoved(tabId);
      a.touched.delete(tabId);
    }
  }

  onGroupRemoved(groupId: number) {
    for (const a of this.all.values()) if (a.groupId === groupId) { a.groupId = undefined; void this.persist(); }
  }

  // ─── overlay actions ───────────────────────────────────────────────────────

  byTab(tab: chrome.tabs.Tab) {
    return [...this.all.values()].find((a) => a.owns(tab.id!, tab.groupId));
  }

  async patchChrome(b: ChromeConnection) {
    this.chrome = b;
    await chrome.storage.local.set({ chrome: b });
  }
  async init() {
    this.chrome = (await getStored()).chrome;
  }
}
