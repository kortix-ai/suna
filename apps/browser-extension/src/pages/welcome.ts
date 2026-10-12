import type { Status } from '../background/types';
import { $, rpc, show } from './rpc';

const connect = $<HTMLButtonElement>('connect'), api = $<HTMLInputElement>('api');
const sections = ['start', 'setup', 'done'];
const step = (id: string) => sections.forEach((s) => ($(s).hidden = s !== id));

const label = () => ($('server-label').textContent = api.value ? new URL(api.value, 'https://x').host : 'Kortix Cloud');
api.oninput = label;

rpc<Status>({ kortix: 'status' }).then((s) => {
  api.value = s.apiUrl === 'https://api.kortix.com' ? '' : s.apiUrl;
  label();
  if (s.signedIn && s.browser) setup(s);
});

connect.onclick = async () => {
  connect.disabled = true;
  show($('err'), '');
  try {
    setup(await rpc<Status>({ kortix: 'signin', apiUrl: api.value.trim() || undefined }));
  } catch (e) {
    show($('err'), (e as Error).message);
  } finally {
    connect.disabled = false;
  }
};

let webUrl = 'https://kortix.com';
function setup(s: Status) {
  webUrl = s.webUrl;
  $<HTMLInputElement>('name').value = s.browser?.name ?? '';
  step('setup');
}

$('finish').onclick = async () => {
  const name = $<HTMLInputElement>('name').value.trim();
  const accessMode = (document.querySelector('input[name=mode]:checked') as HTMLInputElement).value as 'always' | 'ask';
  try {
    await rpc({ kortix: 'patch', body: { ...(name ? { name } : {}), accessMode } });
    $<HTMLAnchorElement>('open').href = webUrl;
    step('done');
  } catch (e) {
    show($('err2'), (e as Error).message);
  }
};
