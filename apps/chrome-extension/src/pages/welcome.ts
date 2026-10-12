import { DEFAULT_API_URL, SERVERS, type Status } from '../background/types';
import { $, rpc, show } from './rpc';

const CUSTOM = 'custom';
const connect = $<HTMLButtonElement>('connect'), server = $<HTMLSelectElement>('server'), api = $<HTMLInputElement>('api');
const step = (id: string) => ['start', 'setup', 'done'].forEach((s) => ($(s).hidden = s !== id));

// Only kortix.com by name; any other server (a test environment, self-host) is "Another server".
server.add(new Option(SERVERS[0].web, SERVERS[0].api));
server.add(new Option('Another server…', CUSTOM));
const syncCustom = () => ($('custom-row').hidden = server.value !== CUSTOM);
server.onchange = syncCustom;

/** The API URL the person picked. */
const pickedApi = () => (server.value === CUSTOM ? api.value.trim() : server.value);
/** "dev.kortix.com" for a known API, else the API host. */
const serverLabel = (apiUrl: string) =>
  SERVERS.find((s) => s.api === apiUrl)?.web ?? (() => { try { return new URL(apiUrl).host; } catch { return apiUrl; } })();

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
  const known = s.apiUrl === SERVERS[0].api;
  server.value = known ? s.apiUrl : s.apiUrl && s.apiUrl !== DEFAULT_API_URL ? CUSTOM : DEFAULT_API_URL;
  if (server.value === CUSTOM) api.value = s.apiUrl;
  syncCustom();
  if (s.signedIn && s.chrome) setup(s);
});

connect.onclick = async () => {
  const apiUrl = pickedApi();
  if (!apiUrl) return show($('err'), 'Enter the API URL of your Kortix server.');
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

let current: Status | undefined;
function setup(s: Status) {
  current = s;
  $('setup-server').textContent = serverLabel(s.apiUrl);
  $<HTMLInputElement>('name').value = s.chrome?.name ?? '';
  const mode = s.chrome?.accessMode === 'ask' ? 'ask' : 'always';
  ($(`setup`).querySelector(`input[name=mode][value=${mode}]`) as HTMLInputElement).checked = true;
  const scope = s.chrome?.tabScope === 'own' ? 'own' : 'all';
  ($(`setup`).querySelector(`input[name=scope][value=${scope}]`) as HTMLInputElement).checked = true;
  step('setup');
}

$('finish').onclick = async () => {
  const name = $<HTMLInputElement>('name').value.trim();
  const accessMode = (document.querySelector('input[name=mode]:checked') as HTMLInputElement).value as 'always' | 'ask';
  const tabScope = (document.querySelector('input[name=scope]:checked') as HTMLInputElement).value as 'all' | 'own';
  try {
    await rpc({ kortix: 'patch', body: { ...(name ? { name } : {}), accessMode, tabScope } });
    $('done-name').textContent = name || current?.chrome?.name || 'This browser';
    $<HTMLAnchorElement>('open').href = current?.webUrl ?? 'https://kortix.com';
    step('done');
  } catch (e) {
    show($('err2'), (e as Error).message);
  }
};
