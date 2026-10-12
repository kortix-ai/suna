import type { AccessMode, Status, TabScope } from '../background/types';
import { $, rpc, show } from './rpc';

let status: Status;

async function refresh() {
  status = await rpc<Status>({ kortix: 'status' });
  $('out').hidden = status.signedIn;
  $('in').hidden = !status.signedIn;
  if (!status.signedIn) return;
  const b = status.browser;
  $('bname').textContent = b?.name ?? 'This browser';
  $('dot').classList.toggle('on', status.online);
  $('state').textContent = status.online ? 'Online' : 'Offline';
  $('server').textContent = new URL(status.apiUrl).host;
  $<HTMLAnchorElement>('manage').href = `${status.webUrl}/settings/browsers`;
  for (const [id, v] of [['mode', b?.accessMode], ['scope', b?.tabScope]] as const) {
    $(id).querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.v === v)));
  }
  const list = $('sessions');
  list.replaceChildren();
  if (!status.attachments.length) {
    const p = document.createElement('p');
    p.textContent = 'No agent is using this browser.';
    return void list.append(p);
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  for (const a of status.attachments) {
    const row = document.createElement('div');
    row.className = 'session';
    const t = Object.assign(document.createElement('span'), { className: 't', textContent: a.title, title: a.title });
    const add = Object.assign(document.createElement('button'), { textContent: 'Add this tab' });
    add.onclick = async () => { if (tab?.id) await rpc({ kortix: 'add-tab', attachmentId: a.attachmentId, tabId: tab.id }); add.textContent = 'Added'; add.disabled = true; };
    const stop = Object.assign(document.createElement('button'), { textContent: 'Stop' });
    stop.onclick = async () => { await rpc({ kortix: 'stop', attachmentId: a.attachmentId }); await refresh(); };
    row.append(t, add, stop);
    list.append(row);
  }
}

const patch = (body: { accessMode?: AccessMode; tabScope?: TabScope }) =>
  rpc({ kortix: 'patch', body }).then(refresh, (e: Error) => show($('err2'), e.message));
$('mode').onclick = (e) => { const v = (e.target as HTMLElement).dataset.v; if (v) void patch({ accessMode: v as AccessMode }); };
$('scope').onclick = (e) => { const v = (e.target as HTMLElement).dataset.v; if (v) void patch({ tabScope: v as TabScope }); };
$('signout').onclick = () => rpc({ kortix: 'signout' }).then(refresh);
$('connect').onclick = async () => {
  try { await rpc({ kortix: 'signin' }); await refresh(); } catch (e) { show($('err'), (e as Error).message); }
};

void refresh();
setInterval(() => void refresh(), 2000);
