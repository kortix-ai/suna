import { DEFAULT_API_URL, SERVERS, type AccessMode, type Status, type TabScope } from '../background/types';
import { DEV_BUILD, markSegment, segmented } from './common';
import { $, rpc, show } from './rpc';

const CUSTOM = 'custom';
const connect = $<HTMLButtonElement>('connect'), server = $<HTMLSelectElement>('server'), api = $<HTMLInputElement>('api');
const step = (id: string) => ['start', 'setup', 'done'].forEach((s) => ($(s).hidden = s !== id));

// A store build signs in to kortix.com and shows no server field. A dev build lists the known servers and "Another server…".
if (DEV_BUILD) {
  $('server-field').hidden = false;
  for (const s of SERVERS) server.add(new Option(s.web, s.api));
  server.add(new Option('Another server…', CUSTOM));
}
const syncCustom = () => ($('custom-row').hidden = server.value !== CUSTOM);
server.onchange = syncCustom;

/** The API URL the person picked. Undefined = the stored server, else kortix.com. */
const pickedApi = () => (!DEV_BUILD ? undefined : server.value === CUSTOM ? api.value.trim() : server.value);

// Back from Kortix sign-in: finish it here, then name the browser.
const back = new URLSearchParams(location.search);
if (back.has('code') || back.has('error')) {
  const url = location.href;
  history.replaceState(null, '', location.pathname);
  connect.disabled = true;
  connect.textContent = 'Finishing sign-in…';
  rpc<Status>({ kortix: 'oauth-done', url }).then(setup, (e: Error) => {
    show($('err'), e.message);
    connect.disabled = false;
    connect.textContent = 'Connect to Kortix';
  });
} else rpc<Status>({ kortix: 'status' }).then((s) => {
  if (DEV_BUILD) {
    const known = SERVERS.some((x) => x.api === s.apiUrl);
    server.value = known ? s.apiUrl : s.apiUrl && s.apiUrl !== DEFAULT_API_URL ? CUSTOM : DEFAULT_API_URL;
    if (server.value === CUSTOM) api.value = s.apiUrl;
    syncCustom();
  }
  if (s.signedIn && s.chrome) setup(s);
});

connect.onclick = async () => {
  const apiUrl = pickedApi();
  if (DEV_BUILD && !apiUrl) return show($('err'), 'Enter the API URL of your Kortix server.');
  connect.disabled = true;
  connect.textContent = 'Waiting for sign-in…';
  show($('err'), '');
  try {
    // This tab goes to the Kortix sign-in page and comes back here when it is done.
    await rpc({ kortix: 'signin', apiUrl });
  } catch (e) {
    show($('err'), (e as Error).message);
    connect.disabled = false;
    connect.textContent = 'Connect to Kortix';
  }
};

const HINTS = {
  always: 'Sessions use this browser when a task needs it. You see every step and can stop it.',
  ask: 'Each session asks here before it starts.',
  all: 'Agents see every tab in every window, and work in a tab of their own.',
  own: 'Your other tabs stay hidden. Agents only use tabs they open.',
};
let mode: AccessMode = 'always', scope: TabScope = 'all';
const paint = () => {
  markSegment($('mode'), mode);
  markSegment($('scope'), scope);
  $('mode-hint').textContent = HINTS[mode as 'always' | 'ask'];
  $('scope-hint').textContent = HINTS[scope];
};
segmented($('mode'), 'Access', (v) => { mode = v as AccessMode; paint(); });
segmented($('scope'), 'Tabs', (v) => { scope = v as TabScope; paint(); });

let current: Status | undefined;
function setup(s: Status) {
  current = s;
  $<HTMLInputElement>('name').value = s.chrome?.name ?? '';
  mode = s.chrome?.accessMode === 'ask' ? 'ask' : 'always';
  scope = s.chrome?.tabScope === 'own' ? 'own' : 'all';
  paint();
  step('setup');
}

$('finish').onclick = async () => {
  const name = $<HTMLInputElement>('name').value.trim();
  try {
    await rpc({ kortix: 'patch', body: { ...(name ? { name } : {}), accessMode: mode, tabScope: scope } });
    $('done-name').textContent = name || current?.chrome?.name || 'This browser';
    $<HTMLAnchorElement>('open').href = `${current?.webUrl ?? 'https://kortix.com'}/settings/chrome`;
    step('done');
  } catch (e) {
    show($('err2'), (e as Error).message);
  }
};
