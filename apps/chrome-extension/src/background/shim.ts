// CDP shim (protocol.md §7). Pure: every browser API goes through `ShimHost`,
// so the unit tests drive it with a fake. One Shim per attachment; one
// ClientState per CDP client (`c` in the bridge frames).

export type TabInfo = {
  id: number;
  windowId: number;
  url: string;
  title: string;
  groupId: number;
  active?: boolean;
};
export type TargetRow = { id: string; tabId?: number; type: string; url: string; title: string };

export interface ShimHost {
  version(): { product: string; userAgent: string };
  listTabs(): Promise<TabInfo[]>;
  getTab(tabId: number): Promise<TabInfo | undefined>;
  /** Scope check (own group or all), including the url scheme rule. */
  inScope(tab: TabInfo): boolean;
  /** The session opened this tab, or the user shared it into the session. */
  owns(tab: TabInfo): boolean;
  /** Create a tab in the session group. The first one is active. */
  createTab(url: string): Promise<TabInfo>;
  closeTab(tabId: number): Promise<void>;
  activateTab(tabId: number): Promise<void>;
  getWindow(windowId: number): Promise<{ windowId: number; bounds: unknown }>;
  /** `chrome.debugger.getTargets()` as plain rows. */
  targets(): Promise<TargetRow[]>;
  attach(tabId: number): Promise<void>;
  detach(tabId: number): Promise<void>;
  send(tabId: number, childSessionId: string | undefined, method: string, params: unknown): Promise<unknown>;
  paused(): boolean;
  /**
   * Called before every Input.dispatchMouseEvent: the overlay moves its cursor
   * and gets its control bar out of the way when the point is under it.
   */
  pointer(tabId: number, params: { type?: string; x?: number; y?: number }): Promise<void>;
  /** Called after the debugger attaches a tab, so the overlay can appear. */
  touched(tabId: number): void;
}

export type Emit = (clientId: string, message: Record<string, unknown>) => void;
type Msg = { id?: number; method?: string; params?: any; sessionId?: string };
type ClientState = {
  discover: boolean;
  announced: Set<number>;
  sessions: Map<string, number>; // minted sessionId -> tabId
};

export class CdpError extends Error {
  constructor(public code: number, message: string) {
    super(message);
  }
}
const PAUSED_MSG = 'The user took over this tab. Wait for them, then retry.';
const CHROME_CONTEXT = 'kortix';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** How long a client gets to answer a page dialog itself before the shim answers OK. */
export const DIALOG_GRACE_MS = 1000;

export class Shim {
  private clients = new Map<string, ClientState>();
  private children = new Map<string, number>(); // child sessionId -> tabId
  private tabUse = new Map<number, number>(); // tabId -> number of client sessions
  private ids = new Map<number, string>(); // tabId -> targetId, kept for targetDestroyed
  private seq = 0;

  constructor(private host: ShimHost, private emit: Emit) {}

  openClient(c: string) {
    this.clients.set(c, { discover: false, announced: new Set(), sessions: new Map() });
  }

  closeClient(c: string) {
    const cl = this.clients.get(c);
    if (!cl) return;
    this.clients.delete(c);
    for (const tabId of cl.sessions.values()) this.unuse(tabId);
  }

  /** Drop every client and release every tab (Stop, bridge close). */
  closeAll() {
    for (const c of [...this.clients.keys()]) this.closeClient(c);
  }

  async handle(c: string, msg: Msg): Promise<void> {
    if (!this.clients.has(c)) this.openClient(c);
    const reply = (body: Record<string, unknown>) =>
      this.emit(c, { id: msg.id, ...body, ...(msg.sessionId ? { sessionId: msg.sessionId } : {}) });
    try {
      reply({ result: (await this.dispatch(c, msg)) ?? {} });
    } catch (e) {
      const code = e instanceof CdpError ? e.code : -32000;
      reply({ error: { code, message: e instanceof Error ? e.message : String(e) } });
    }
  }

  // ─── dispatch ──────────────────────────────────────────────────────────────

  private async dispatch(c: string, msg: Msg): Promise<unknown> {
    const method = msg.method ?? '';
    const p = msg.params ?? {};
    const cl = this.clients.get(c)!;
    if (msg.sessionId && !LOCAL.has(method)) return this.session(cl, msg.sessionId, method, p);
    switch (method) {
      case 'Browser.getVersion': {
        const v = this.host.version();
        return { protocolVersion: '1.3', product: v.product, revision: '', userAgent: v.userAgent, jsVersion: '' };
      }
      case 'Browser.getWindowForTarget': {
        const tabId = await this.tabFor(cl, p.targetId, msg.sessionId);
        const tab = await this.host.getTab(tabId);
        if (!tab) throw new CdpError(-32602, 'No target with given id found');
        return this.host.getWindow(tab.windowId);
      }
      case 'Browser.setContentsSize':
      case 'Browser.setDownloadBehavior':
      case 'Browser.close':
      case 'Target.setAutoAttach':
        return {};
      case 'Target.setDiscoverTargets': {
        cl.discover = !!p.discover;
        if (cl.discover) {
          const tabs = await this.scopedTabs();
          queueMicrotask(() => void this.announceAll(c, cl, tabs));
        }
        return {};
      }
      case 'Target.getTargets':
        return { targetInfos: await this.infos(cl, await this.scopedTabs()) };
      case 'Target.createTarget': {
        const tab = await this.host.createTab(p.url || 'about:blank');
        const [info] = await this.infos(cl, [tab]);
        if (!info) throw new CdpError(-32000, 'Failed to open a tab');
        return { targetId: info.targetId };
      }
      case 'Target.attachToTarget': {
        const tabId = await this.tabFor(cl, p.targetId);
        return { sessionId: await this.attachTab(c, cl, tabId) };
      }
      case 'Target.detachFromTarget': {
        const tabId = cl.sessions.get(p.sessionId);
        if (tabId === undefined) throw new CdpError(-32602, 'Session with given id not found.');
        cl.sessions.delete(p.sessionId);
        this.emit(c, { method: 'Target.detachedFromTarget', params: { sessionId: p.sessionId, targetId: await this.idOf(tabId) } });
        this.unuse(tabId);
        return {};
      }
      case 'Target.closeTarget': {
        await this.host.closeTab(await this.tabFor(cl, p.targetId));
        return { success: true };
      }
      case 'Target.activateTarget': {
        await this.host.activateTab(await this.tabFor(cl, p.targetId));
        return {};
      }
      case 'Target.getTargetInfo': {
        if (!p.targetId && !msg.sessionId) {
          return { targetInfo: { targetId: 'kortix', type: 'browser', title: '', url: '', attached: true, canAccessOpener: false } };
        }
        const tabId = await this.tabFor(cl, p.targetId, msg.sessionId);
        const tab = await this.host.getTab(tabId);
        const [info] = tab ? await this.infos(cl, [tab]) : [];
        if (!info) throw new CdpError(-32602, 'No target with given id found');
        return { targetInfo: info };
      }
      default:
        throw new CdpError(-32601, `${method} is not available in Kortix for Chrome`);
    }
  }

  private async session(cl: ClientState, sessionId: string, method: string, params: any): Promise<unknown> {
    let tabId = cl.sessions.get(sessionId);
    let child: string | undefined;
    if (tabId === undefined && this.children.has(sessionId)) {
      tabId = this.children.get(sessionId);
      child = sessionId;
    }
    if (tabId === undefined) throw new CdpError(-32001, 'Session with given id not found.');
    if (method.startsWith('Input.') && this.host.paused()) throw new CdpError(-32000, PAUSED_MSG);
    // Awaited: the page hit-tests the event, and the control bar must not take an agent click.
    if (method === 'Input.dispatchMouseEvent') await this.host.pointer(tabId, params ?? {});
    if (method === 'Page.captureScreenshot') await this.host.activateTab(tabId);
    if (method === 'Kortix.setFileInputFiles') return this.setFiles(tabId, child, params);
    this.inflight.set(tabId, (this.inflight.get(tabId) ?? 0) + 1);
    try {
      return await this.host.send(tabId, child, method, params);
    } finally {
      this.inflight.set(tabId, (this.inflight.get(tabId) ?? 1) - 1);
    }
  }

  /**
   * The tabs a client may see, the session's own first. A CDP client attaches
   * to the first page it is given and `open` navigates it, so with "All tabs"
   * the agent must start in a tab of its own, never in one the user is reading.
   */
  private async scopedTabs(): Promise<TabInfo[]> {
    const tabs = (await this.host.listTabs()).filter((t) => this.host.inScope(t));
    const own = tabs.filter((t) => this.host.owns(t));
    if (!own.length) own.push(await this.host.createTab('about:blank'));
    return [...own, ...tabs.filter((t) => !own.some((o) => o.id === t.id))];
  }

  /**
   * The sandbox sent the file bytes (kortixd rewrites DOM.setFileInputFiles):
   * build real File objects in the page and select them on the input, then fire
   * input + change like a person choosing files.
   */
  private async setFiles(tabId: number, child: string | undefined, p: any) {
    let objectId: string | undefined = p?.objectId;
    if (!objectId) {
      const r = (await this.host.send(tabId, child, 'DOM.resolveNode', { nodeId: p?.nodeId, backendNodeId: p?.backendNodeId })) as any;
      objectId = r?.object?.objectId;
    }
    if (!objectId) throw new CdpError(-32000, 'Could not find the file input');
    await this.host.send(tabId, child, 'Runtime.callFunctionOn', {
      objectId,
      arguments: [{ value: p?.files ?? [] }],
      awaitPromise: true,
      functionDeclaration: `function (files) {
        const dt = new DataTransfer();
        for (const f of files) {
          const bytes = Uint8Array.from(atob(f.data), (ch) => ch.charCodeAt(0));
          dt.items.add(new File([bytes], f.name, { type: f.type || 'application/octet-stream' }));
        }
        this.files = dt.files;
        this.dispatchEvent(new Event('input', { bubbles: true }));
        this.dispatchEvent(new Event('change', { bubbles: true }));
      }`,
    });
    return {};
  }

  // ─── tabs and sessions ─────────────────────────────────────────────────────

  private async tabFor(cl: ClientState, targetId?: string, sessionId?: string): Promise<number> {
    if (!targetId) {
      const t = sessionId !== undefined ? cl.sessions.get(sessionId) ?? this.children.get(sessionId) : undefined;
      if (t === undefined) throw new CdpError(-32602, 'targetId is required');
      return t;
    }
    const row = (await this.host.targets()).find((r) => r.id === targetId);
    const tab = row?.tabId !== undefined ? await this.host.getTab(row.tabId) : undefined;
    if (!row || !tab || !this.host.inScope(tab)) throw new CdpError(-32602, 'No target with given id found');
    return tab.id;
  }

  private async attachTab(c: string, cl: ClientState, tabId: number): Promise<string> {
    if (!this.tabUse.get(tabId)) await this.host.attach(tabId);
    this.host.touched(tabId);
    this.tabUse.set(tabId, (this.tabUse.get(tabId) ?? 0) + 1);
    const sessionId = `K${++this.seq}${Math.random().toString(16).slice(2, 10).toUpperCase()}`;
    cl.sessions.set(sessionId, tabId);
    const tab = await this.host.getTab(tabId);
    const [info] = tab ? await this.infos(cl, [tab], true) : [];
    this.emit(c, { method: 'Target.attachedToTarget', params: { sessionId, targetInfo: info, waitingForDebugger: false } });
    return sessionId;
  }

  private unuse(tabId: number) {
    const n = (this.tabUse.get(tabId) ?? 1) - 1;
    if (n > 0) return this.tabUse.set(tabId, n);
    this.tabUse.delete(tabId);
    for (const [id, t] of this.children) if (t === tabId) this.children.delete(id);
    void this.host.detach(tabId).catch(() => {});
  }

  private async idOf(tabId: number): Promise<string | undefined> {
    return this.ids.get(tabId) ?? (await this.host.targets()).find((r) => r.tabId === tabId)?.id;
  }

  /** TargetInfo for tabs. Retries while Chrome has not listed a new tab yet. */
  private async infos(cl: ClientState, tabs: TabInfo[], attached = false) {
    let rows: TargetRow[] = [];
    for (let i = 0; i < 20; i++) {
      rows = await this.host.targets();
      if (tabs.every((t) => rows.some((r) => r.tabId === t.id))) break;
      await sleep(100);
    }
    const open = new Set(cl.sessions.values());
    return tabs.flatMap((t) => {
      const row = rows.find((r) => r.tabId === t.id);
      if (!row) return [];
      this.ids.set(t.id, row.id);
      return [{
        targetId: row.id, type: 'page', title: t.title || row.title, url: t.url || row.url,
        attached: attached || open.has(t.id), canAccessOpener: false, chromeContextId: CHROME_CONTEXT,
      }];
    });
  }

  private async announceAll(c: string, cl: ClientState, tabs: TabInfo[]) {
    for (const t of tabs) await this.announce(c, cl, t);
  }

  private async announce(c: string, cl: ClientState, tab: TabInfo) {
    const [info] = await this.infos(cl, [tab]);
    if (!info || !this.clients.has(c)) return;
    const method = cl.announced.has(tab.id) ? 'Target.targetInfoChanged' : 'Target.targetCreated';
    cl.announced.add(tab.id);
    this.emit(c, { method, params: { targetInfo: info } });
  }

  // ─── events in ─────────────────────────────────────────────────────────────

  /** `chrome.debugger.onEvent`. `child` is `source.sessionId`. */
  /**
   * A page dialog (alert/confirm/prompt/beforeunload) freezes the page. A client
   * whose click is still waiting on the frozen page, and that queues its
   * "accept" behind that click, deadlocks (agent-browser 0.27). If a command to
   * the tab is still in flight DIALOG_GRACE_MS after the dialog opened, answer
   * it: OK, with the default text for a prompt. A client that is not stuck
   * decides itself (`dialog accept|dismiss`).
   */
  private dialogs = new Map<number, ReturnType<typeof setTimeout>>();
  private inflight = new Map<number, number>();
  private onDialog(tabId: number, child: string | undefined, method: string, params: any) {
    if (method === 'Page.javascriptDialogClosed') {
      clearTimeout(this.dialogs.get(tabId));
      this.dialogs.delete(tabId);
    } else if (method === 'Page.javascriptDialogOpening') {
      clearTimeout(this.dialogs.get(tabId));
      this.dialogs.set(tabId, setTimeout(() => {
        this.dialogs.delete(tabId);
        if (!this.inflight.get(tabId)) return; // nothing is stuck: the client decides
        void this.host
          .send(tabId, child, 'Page.handleJavaScriptDialog', { accept: true, ...(params?.type === 'prompt' ? { promptText: params?.defaultPrompt ?? '' } : {}) })
          .catch(() => {}); // already closed by the user or a client
      }, DIALOG_GRACE_MS));
    }
  }

  onDebuggerEvent(tabId: number, child: string | undefined, method: string, params: any) {
    if (method.startsWith('Page.javascriptDialog')) this.onDialog(tabId, child, method, params);
    if (method === 'Target.attachedToTarget' && params?.sessionId) this.children.set(params.sessionId, tabId);
    if (method === 'Target.detachedFromTarget' && params?.sessionId) this.children.delete(params.sessionId);
    for (const [c, cl] of this.clients) {
      for (const [sid, t] of cl.sessions) {
        if (t !== tabId) continue;
        this.emit(c, { method, params, sessionId: child ?? sid });
        if (child) break; // child ids are shared: one copy per client
      }
    }
  }

  onTabCreated(tab: TabInfo) {
    if (!this.host.inScope(tab)) return;
    for (const [c, cl] of this.clients) if (cl.discover) void this.announce(c, cl, tab);
  }

  onTabUpdated(tab: TabInfo) {
    const inScope = this.host.inScope(tab);
    for (const [c, cl] of this.clients) {
      if (!cl.discover) continue;
      if (inScope) void this.announce(c, cl, tab);
      else if (cl.announced.has(tab.id)) this.destroyed(c, cl, tab.id);
    }
  }

  onTabRemoved(tabId: number) {
    this.dropTab(tabId, true);
  }

  /** The debugger lost the tab (tab closed, DevTools opened, user cancel). */
  onDebuggerDetach(tabId: number) {
    this.dropTab(tabId, false);
  }

  private dropTab(tabId: number, destroyed: boolean) {
    for (const [c, cl] of this.clients) {
      for (const [sid, t] of [...cl.sessions]) {
        if (t !== tabId) continue;
        cl.sessions.delete(sid);
        this.emit(c, { method: 'Target.detachedFromTarget', params: { sessionId: sid } });
      }
      if (destroyed && cl.announced.has(tabId)) this.destroyed(c, cl, tabId);
    }
    this.tabUse.delete(tabId);
    for (const [id, t] of this.children) if (t === tabId) this.children.delete(id);
    if (destroyed) this.ids.delete(tabId);
  }

  private destroyed(c: string, cl: ClientState, tabId: number) {
    cl.announced.delete(tabId);
    const targetId = this.ids.get(tabId);
    if (targetId) this.emit(c, { method: 'Target.targetDestroyed', params: { targetId } });
  }
}

const LOCAL = new Set([
  'Browser.getVersion', 'Browser.getWindowForTarget', 'Browser.setContentsSize', 'Browser.setDownloadBehavior', 'Browser.close',
  'Target.setDiscoverTargets', 'Target.getTargets', 'Target.createTarget', 'Target.attachToTarget', 'Target.detachFromTarget',
  'Target.closeTarget', 'Target.activateTarget', 'Target.getTargetInfo',
]);
