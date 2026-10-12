import type { Status } from '../background/types';
import { accountsDiffer, getStatus, identityFrom, openInTab, openWelcome, whoami, type Identity } from './common';
import { $, rpc } from './rpc';

const frame = $<HTMLIFrameElement>('app');
let webUrl = '';
let lastSrc = '';
let mine: Identity | undefined;
let theirs: Identity | undefined;

const go = (url: string) => { lastSrc = url; frame.src = url; };

function checkAccounts() {
  const differ = accountsDiffer(mine, theirs);
  $('warn').hidden = !differ;
  if (differ) $('warn-text').textContent = `This panel is signed in as ${theirs?.email || 'another account'}, not ${mine?.email || 'this browser’s account'}.`;
}

function renderChips(s: Status) {
  const chips = $('chips');
  chips.hidden = !s.attachments.length;
  chips.replaceChildren(...s.attachments.map((a) => {
    const row = document.createElement('div');
    row.className = 'chip';
    const open = Object.assign(document.createElement('button'), { className: 'chip-open', textContent: `Open ${a.title}`, title: a.title });
    open.onclick = () => go(`${webUrl}/projects/${a.projectId}/sessions/${a.sessionId}`);
    const stop = Object.assign(document.createElement('button'), { className: 'chip-stop', textContent: 'Stop' });
    stop.onclick = async () => { await rpc({ kortix: 'stop', attachmentId: a.attachmentId }); await refresh(); };
    row.append(open, stop);
    return row;
  }));
}

async function refresh() {
  const s = await getStatus();
  $('out').hidden = s.signedIn;
  $('in').hidden = !s.signedIn;
  if (!s.signedIn) { mine = undefined; return; }
  $('bname').textContent = s.browser?.name ?? 'This browser';
  $('dot').classList.toggle('on', s.online);
  $('dot').title = s.online ? 'Online' : 'Offline';
  if (s.webUrl !== webUrl) {
    webUrl = s.webUrl;
    theirs = undefined;
    go(`${webUrl}/projects`);
  }
  renderChips(s);
  if (!mine) mine = await whoami().catch(() => undefined);
  checkAccounts();
}

addEventListener('message', (e) => {
  const id = identityFrom(e, webUrl, frame.contentWindow);
  if (id) { theirs = id; checkAccounts(); }
});

const menu = $('menu');
const setMenu = (open: boolean) => { menu.hidden = !open; $('menu-btn').setAttribute('aria-expanded', String(open)); };
$('menu-btn').onclick = (e) => { e.stopPropagation(); setMenu(menu.hidden); };
addEventListener('click', () => setMenu(false));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setMenu(false); });
$('m-settings').onclick = () => void chrome.runtime.openOptionsPage();
$('m-manage').onclick = () => openInTab(`${webUrl}/settings/browsers`);
$('m-signout').onclick = () => rpc({ kortix: 'signout' }).then(() => { mine = undefined; go('about:blank'); webUrl = ''; return refresh(); });
$('open').onclick = () => openInTab(webUrl);
$('reload').onclick = () => { theirs = undefined; go(lastSrc); checkAccounts(); };
$('connect').onclick = () => void openWelcome();

void refresh();
setInterval(() => void refresh(), 2000);
