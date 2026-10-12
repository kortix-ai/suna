import { DEFAULT_API_URL, SERVERS, type Status } from '../background/types';
import { $, rpc, show } from './rpc';

const CUSTOM = 'custom';
const connect = $<HTMLButtonElement>('connect'), server = $<HTMLSelectElement>('server'), api = $<HTMLInputElement>('api');
const step = (id: string) => ['start', 'setup', 'done'].forEach((s) => ($(s).hidden = s !== id));

for (const s of SERVERS) server.add(new Option(s.web, s.api));
server.add(new Option('Another server…', CUSTOM));
const syncCustom = () => ($('custom-row').hidden = server.value !== CUSTOM);
server.onchange = syncCustom;

/** The API URL the person picked. */
const pickedApi = () => (server.value === CUSTOM ? api.value.trim() : server.value);
/** "dev.kortix.com" for a known API, else the API host. */
const serverLabel = (apiUrl: string) =>
  SERVERS.find((s) => s.api === apiUrl)?.web ?? (() => { try { return new URL(apiUrl).host; } catch { return apiUrl; } })();

rpc<Status>({ kortix: 'status' }).then((s) => {
  const known = SERVERS.some((x) => x.api === s.apiUrl);
  server.value = known ? s.apiUrl : s.apiUrl && s.apiUrl !== DEFAULT_API_URL ? CUSTOM : DEFAULT_API_URL;
  if (server.value === CUSTOM) api.value = s.apiUrl;
  syncCustom();
  if (s.signedIn && s.browser) setup(s);
});

connect.onclick = async () => {
  const apiUrl = pickedApi();
  if (!apiUrl) return show($('err'), 'Enter the API URL of your Kortix server.');
  connect.disabled = true;
  connect.textContent = 'Waiting for sign-in…';
  show($('err'), '');
  try {
    setup(await rpc<Status>({ kortix: 'signin', apiUrl }));
  } catch (e) {
    show($('err'), (e as Error).message);
  } finally {
    connect.disabled = false;
    connect.textContent = 'Connect to Kortix';
  }
};

let current: Status | undefined;
function setup(s: Status) {
  current = s;
  $('setup-server').textContent = serverLabel(s.apiUrl);
  $<HTMLInputElement>('name').value = s.browser?.name ?? '';
  const mode = s.browser?.accessMode === 'ask' ? 'ask' : 'always';
  ($(`setup`).querySelector(`input[value=${mode}]`) as HTMLInputElement).checked = true;
  step('setup');
}

$('finish').onclick = async () => {
  const name = $<HTMLInputElement>('name').value.trim();
  const accessMode = (document.querySelector('input[name=mode]:checked') as HTMLInputElement).value as 'always' | 'ask';
  try {
    await rpc({ kortix: 'patch', body: { ...(name ? { name } : {}), accessMode } });
    $('done-name').textContent = name || current?.browser?.name || 'This browser';
    $<HTMLAnchorElement>('open').href = current?.webUrl ?? 'https://kortix.com';
    step('done');
  } catch (e) {
    show($('err2'), (e as Error).message);
  }
};
