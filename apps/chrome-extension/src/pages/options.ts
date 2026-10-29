import type { AccessMode, TabScope } from '../background/types';
import { getStatus, markSegment, openWelcome, segmented, whoami } from './common';
import { $, rpc, show } from './rpc';

let email = '';
async function refresh() {
  const s = await getStatus();
  $('out').hidden = s.signedIn;
  $('in').hidden = !s.signedIn;
  if (!s.signedIn) return;
  $('bname').textContent = s.chrome?.name ?? 'This browser';
  $('dot').classList.toggle('on', s.online);
  $('state').textContent = s.online ? 'Online' : 'Offline';
  // The server is worth a line only when it is not the default one.
  const host = new URL(s.apiUrl).host;
  $('server-row').hidden = host === 'api.kortix.com';
  $('server-row').textContent = ` · ${host}`;
  $<HTMLAnchorElement>('manage').href = `${s.webUrl}/settings/chrome`;
  markSegment($('mode'), s.chrome?.accessMode);
  markSegment($('scope'), s.chrome?.tabScope);
  email ||= (await whoami().catch(() => undefined))?.email ?? '';
  $('email').textContent = email || '—';
  const cmds = await chrome.commands.getAll();
  $('key').textContent = cmds.find((c) => c.name === '_execute_action')?.shortcut || 'Not set';
  $('stopkey').textContent = cmds.find((c) => c.name === 'kortix-stop')?.shortcut || 'Not set';
}

const patch = (body: { accessMode?: AccessMode; tabScope?: TabScope }) =>
  rpc({ kortix: 'patch', body }).then(() => { show($('err'), ''); return refresh(); }, (e: Error) => show($('err'), e.message));
segmented($('mode'), 'Access', (v) => void patch({ accessMode: v as AccessMode }));
segmented($('scope'), 'Tabs', (v) => void patch({ tabScope: v as TabScope }));
// chrome:// links do not open from an href in an extension page.
$('shortcuts').onclick = (e) => { e.preventDefault(); void chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }); };
$('signout').onclick = () => rpc({ kortix: 'signout' }).then(() => { email = ''; return refresh(); });
$('connect').onclick = () => void openWelcome();

// Disconnect asks once, inline.
const ask = (on: boolean) => { $('disconnect').hidden = on; $('confirm').hidden = !on; if (on) $('cancel').focus(); else $('disconnect').focus(); };
$('disconnect').onclick = () => ask(true);
$('cancel').onclick = () => ask(false);
$('really').onclick = () => rpc({ kortix: 'disconnect' }).then(() => { email = ''; ask(false); return refresh(); }, (e: Error) => { ask(false); show($('err'), e.message); });

void refresh();
chrome.storage.onChanged.addListener(() => void refresh());
setInterval(() => void refresh(), 5000); // the online dot lives in the worker, not in storage
