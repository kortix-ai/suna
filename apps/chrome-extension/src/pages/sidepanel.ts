import type { Status } from '../background/types';
import { accountsDiffer, getStatus, identityFrom, needsSession, openInTab, openWelcome, PanelHandoff, reconcile, whoami, type Identity } from './common';
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
const panelHome = () => `${webUrl}/auth/panel?next=${encodeURIComponent('/projects')}`;

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
});

const menu = $('menu');
const setMenu = (open: boolean) => { menu.hidden = !open; $('menu-btn').setAttribute('aria-expanded', String(open)); };
$('menu-btn').onclick = (e) => { e.stopPropagation(); setMenu(menu.hidden); };
addEventListener('click', () => setMenu(false));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { setMenu(false); $('menu-btn').focus(); } });
$('m-settings').onclick = () => void chrome.runtime.openOptionsPage();
$('m-signout').onclick = () => rpc({ kortix: 'signout' }).then(() => { mine = undefined; go('about:blank'); webUrl = ''; return refresh(); });
$('open').onclick = () => openInTab(webUrl);
$('switch').onclick = () => { theirs = undefined; go(`${webUrl}/auth/panel?switch=1&next=${encodeURIComponent('/projects')}`); checkAccounts(); };
$('dismiss').onclick = () => { dismissed = `${theirs?.userId}|${mine?.userId}`; checkAccounts(); };
$('connect').onclick = () => void openWelcome();

void refresh();
// Sessions come and go through storage; the online dot lives in the worker, so it gets a slow poll.
chrome.storage.onChanged.addListener(() => void refresh());
setInterval(() => void refresh(), 5000);
