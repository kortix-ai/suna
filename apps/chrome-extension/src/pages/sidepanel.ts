import type { Status } from '../background/types';
import { accountsDiffer, getStatus, identityFrom, needsSession, openInTab, openWelcome, PanelHandoff, reconcile, whoami, type Identity } from './common';
import { freshAct, MAX_PAGE_CHARS, panelRequest, readPage, toPanelTab, type PanelContext, type PanelPage, type PanelRequest } from './panel-bridge';
import { $, rpc } from './rpc';

const frame = $<HTMLIFrameElement>('app');
let webUrl = '';
let mine: Identity | undefined;
let theirs: Identity | undefined;
let dismissed = '';

// The panel's web page has no cookie of its own (Chrome hides SameSite=Lax cookies from extension frames):
// it asks for a session, and the extension mints one for this browser's account.
const handoff = new PanelHandoff(
  async () => (await rpc<{ tokenHash: string }>({ kortix: 'panel-session' })).tokenHash,
  (tokenHash) => frame.contentWindow?.postMessage({ type: 'kortix.panel.session', tokenHash }, new URL(webUrl).origin),
);

const go = (url: string) => { handoff.reset(); frame.src = url; };
// A fresh chat every time the panel opens.
const panelHome = () => `${webUrl}/auth/panel?next=${encodeURIComponent('/panel')}`;

function checkAccounts() {
  const differ = accountsDiffer(mine, theirs);
  const key = `${theirs?.userId}|${mine?.userId}`;
  $('warn').hidden = !differ || dismissed === key;
  if (differ) $('warn-text').textContent = `The panel shows ${theirs?.email || 'another account'}. This browser is connected as ${mine?.email || 'a different account'}.`;
  if (differ) $('switch').textContent = mine?.email ? `Sign in as ${mine.email}` : 'Switch account';
}

function renderChips(s: Status) {
  const chips = $('chips');
  chips.hidden = !s.attachments.length;
  reconcile(chips, s.attachments, (a) => a.attachmentId, (a) => {
    const row = document.createElement('div');
    row.className = 'chip';
    const open = Object.assign(document.createElement('button'), { className: 'chip-open' });
    const add = Object.assign(document.createElement('button'), { className: 'sm chip-add', textContent: 'Add this tab' });
    const stop = Object.assign(document.createElement('button'), { className: 'sm chip-stop', textContent: 'Stop' });
    stop.onclick = () => void rpc({ kortix: 'stop', attachmentId: a.attachmentId }).then(refresh);
    add.onclick = async () => {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (!tab?.id) return;
      await rpc({ kortix: 'add-tab', attachmentId: a.attachmentId, tabId: tab.id });
      add.textContent = 'Added';
      setTimeout(() => (add.textContent = 'Add this tab'), 1500);
    };
    row.append(open, add, stop);
    return row;
  }, (row, a) => {
    const open = row.querySelector('.chip-open') as HTMLButtonElement;
    open.textContent = a.title;
    open.title = a.title;
    open.setAttribute('aria-label', `Open ${a.title}`);
    open.onclick = () => go(`${webUrl}/projects/${a.projectId}/sessions/${a.sessionId}`);
  });
}

async function refresh() {
  const s = await getStatus();
  $('out').hidden = s.signedIn;
  $('in').hidden = !s.signedIn;
  if (!s.signedIn) { mine = undefined; return; }
  $('bname').textContent = s.chrome?.name ?? 'This browser';
  $('bname').title = s.chrome?.name ?? '';
  $('dot').classList.toggle('on', s.online);
  $('dot').title = s.online ? 'Online' : 'Offline';
  if (s.webUrl !== webUrl) {
    webUrl = s.webUrl;
    theirs = undefined;
    go(panelHome());
  }
  renderChips(s);
  if (!mine) mine = await whoami().catch(() => undefined);
  checkAccounts();
}

addEventListener('message', (e) => {
  if (needsSession(e, webUrl, frame.contentWindow)) return void handoff.onNeedSession();
  const id = identityFrom(e, webUrl, frame.contentWindow);
  if (id) { theirs = id; checkAccounts(); }
  const req = panelRequest(e, webUrl, frame.contentWindow);
  if (req) void onPanelRequest(req);
});

// ─── the page channel (protocol.md §11) ──────────────────────────────────────

let windowId: number | undefined;
/** The path the panel's page shows, from its own `route` messages. */
let framePath = '';
/** An Act send: its tab goes to the session the page opens next. */
let act: { tabId: number; at: number } | undefined;
const post = (msg: Record<string, unknown>) => {
  try { frame.contentWindow?.postMessage(msg, new URL(webUrl).origin); } catch { /* no web app yet */ }
};

async function activeTab() {
  const [t] = await chrome.tabs.query({ active: true, ...(windowId === undefined ? { lastFocusedWindow: true } : { windowId }) });
  return (t && toPanelTab(t)) ?? null;
}
const pushTab = async () => post({ type: 'kortix.panel.tab', tab: await activeTab() });

/** Hand a right-click to the page. A page that is not the new chat gets the new chat first. */
async function pushContext() {
  const { panelContext: c } = (await chrome.storage.session.get('panelContext')) as { panelContext?: PanelContext };
  if (!c || !webUrl) return;
  // `/panel` or `/<locale>/panel`. Any other page gets the new chat first; its hello takes the context.
  if (!/\/panel$/.test(framePath)) return void go(panelHome());
  await chrome.storage.session.remove('panelContext');
  const t = await chrome.tabs.get(c.tabId).catch(() => undefined);
  post({ type: 'kortix.panel.context', tab: (t && toPanelTab(t)) ?? null, ...(c.quote ? { quote: c.quote } : {}) });
}

async function readTabs(tabIds: number[]): Promise<PanelPage[]> {
  return Promise.all(tabIds.map(async (tabId): Promise<PanelPage> => {
    try {
      const [r] = await chrome.scripting.executeScript({ target: { tabId }, func: readPage, args: [MAX_PAGE_CHARS] });
      const page = r?.result as Omit<Extract<PanelPage, { text: string }>, 'tabId'> | undefined;
      return page ? { tabId, ...page } : { tabId, error: 'unreadable' };
    } catch {
      return { tabId, error: 'unreadable' };
    }
  }));
}

async function onPanelRequest(req: PanelRequest) {
  switch (req.type) {
    case 'kortix.panel.hello':
      framePath = '/panel';
      await pushTab();
      return pushContext();
    case 'kortix.panel.tabs': {
      const tabs = await chrome.tabs.query(windowId === undefined ? { lastFocusedWindow: true } : { windowId });
      return post({ type: 'kortix.panel.tabs.result', requestId: req.requestId, tabs: tabs.map(toPanelTab).filter(Boolean) });
    }
    case 'kortix.panel.read':
      return post({ type: 'kortix.panel.read.result', requestId: req.requestId, pages: await readTabs(req.tabIds) });
    case 'kortix.panel.act':
      act = { tabId: req.tabId, at: Date.now() };
      return;
    case 'kortix.panel.route': {
      framePath = req.path;
      const tabId = freshAct(act, Date.now());
      if (req.sessionId && tabId !== undefined) {
        act = undefined;
        await rpc({ kortix: 'act-tab', sessionId: req.sessionId, tabId });
      }
      return;
    }
  }
}

void chrome.windows.getCurrent().then((w) => { windowId = w.id; });
chrome.tabs.onActivated.addListener((info) => { if (info.windowId === windowId) void pushTab(); });
chrome.tabs.onUpdated.addListener((_id, change, tab) => {
  if (tab.active && tab.windowId === windowId && (change.title || change.url || change.status === 'complete')) void pushTab();
});

const menu = $('menu');
const setMenu = (open: boolean) => { menu.hidden = !open; $('menu-btn').setAttribute('aria-expanded', String(open)); };
$('menu-btn').onclick = (e) => { e.stopPropagation(); setMenu(menu.hidden); };
addEventListener('click', () => setMenu(false));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { setMenu(false); $('menu-btn').focus(); } });
$('m-settings').onclick = () => void chrome.runtime.openOptionsPage();
$('m-signout').onclick = () => rpc({ kortix: 'signout' }).then(() => { mine = undefined; go('about:blank'); webUrl = ''; return refresh(); });
$('open').onclick = () => openInTab(webUrl);
$('switch').onclick = () => { theirs = undefined; go(`${webUrl}/auth/panel?switch=1&next=${encodeURIComponent('/panel')}`); checkAccounts(); };
$('new').onclick = () => go(panelHome());
$('dismiss').onclick = () => { dismissed = `${theirs?.userId}|${mine?.userId}`; checkAccounts(); };
$('connect').onclick = () => void openWelcome();

void refresh();
// Sessions come and go through storage; the online dot lives in the worker, so it gets a slow poll.
chrome.storage.onChanged.addListener((c, area) => {
  if (area === 'session' && c.panelContext?.newValue) void pushContext();
  void refresh();
});
setInterval(() => void refresh(), 5000);
