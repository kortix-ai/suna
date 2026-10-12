import type { AccessMode, TabScope } from '../background/types';
import { getStatus, markSegment, openWelcome, whoami } from './common';
import { $, rpc, show } from './rpc';

async function refresh() {
  const s = await getStatus();
  $('out').hidden = s.signedIn;
  $('in').hidden = !s.signedIn;
  if (!s.signedIn) return;
  markSegment($('mode'), s.chrome?.accessMode);
  markSegment($('scope'), s.chrome?.tabScope);
  $('server').textContent = new URL(s.apiUrl).host;
  $('email').textContent = (await whoami().catch(() => undefined))?.email || '—';
  const cmd = (await chrome.commands.getAll()).find((c) => c.name === '_execute_action');
  $('key').textContent = cmd?.shortcut || 'Not set';
}

const patch = (body: { accessMode?: AccessMode; tabScope?: TabScope }) =>
  rpc({ kortix: 'patch', body }).then(() => { show($('err'), ''); return refresh(); }, (e: Error) => show($('err'), e.message));
$('mode').onclick = (e) => { const v = (e.target as HTMLElement).dataset.v; if (v) void patch({ accessMode: v as AccessMode }); };
$('scope').onclick = (e) => { const v = (e.target as HTMLElement).dataset.v; if (v) void patch({ tabScope: v as TabScope }); };
// chrome:// links do not open from an href in an extension page.
$('shortcuts').onclick = (e) => { e.preventDefault(); void chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }); };
$('signout').onclick = () => rpc({ kortix: 'signout' }).then(refresh);
$('connect').onclick = () => void openWelcome();

void refresh();
chrome.storage.onChanged.addListener(() => void refresh());
