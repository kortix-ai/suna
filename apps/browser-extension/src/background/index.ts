import { getToken, normalizeApiUrl, signIn, signOutLocal } from './auth';
import { Control } from './control';
import { Hub } from './hub';
import { getStored, setStored } from './state';
import { DEFAULT_API_URL, type PageMessage, type Status } from './types';

const hub = new Hub((f) => control.send(f));
const control: Control = new Control({
  attach: (f) => void hub.onAttach(f),
  detach: (id) => void hub.onDetachFrame(id, 'closed'),
  browser: (b) => void hub.patchBrowser(b),
  authed: (b) => void hub.patchBrowser(b),
  disconnected: () => void hub.endAll('closed'),
});

const boot = (async () => {
  await hub.init();
  await hub.restore();
  await control.connect();
})();

chrome.alarms.create('keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => void boot.then(() => control.connect()));
chrome.runtime.onStartup.addListener(() => void boot);
// Installed from a Kortix page (the connect dialog links to the Web Store):
// sign in to that page's server, so the person never picks one.
chrome.runtime.onInstalled.addListener(async (d) => {
  if (d.reason !== 'install') return;
  const tabs = await chrome.tabs.query({ url: Object.keys(HOST_API).map((o) => `${o}/*`) });
  const recent = tabs.sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))[0];
  const api = recent?.url ? HOST_API[new URL(recent.url).origin] : undefined;
  if (api && !(await getStored()).token) await setStored({ apiUrl: api });
  void chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') });
});

// Signed in somewhere else (or credentials seeded): dial without a restart.
chrome.storage.onChanged.addListener((c, area) => {
  if (area === 'local' && c.token?.newValue && !control.online) void control.connect();
});

chrome.debugger.onEvent.addListener((src, method, params) => hub.onDebuggerEvent(src, method, params));
chrome.debugger.onDetach.addListener((src, reason) => hub.onDebuggerDetach(src, reason));
chrome.tabs.onCreated.addListener((t) => void hub.onTabCreated(t));
chrome.tabs.onUpdated.addListener((id, change, tab) => hub.onTabUpdated(id, change, tab));
chrome.tabs.onRemoved.addListener((id) => hub.onTabRemoved(id));
chrome.tabGroups.onRemoved.addListener((g) => hub.onGroupRemoved(g.id));
chrome.windows.onRemoved.addListener((id) => hub.onWindowRemoved(id));

// ─── REST helper and status ──────────────────────────────────────────────────

async function api(path: string, init: RequestInit = {}) {
  const [{ apiUrl }, token] = [await getStored(), await getToken()];
  if (!token) throw new Error('Sign in to Kortix first.');
  const r = await fetch(`${apiUrl ?? DEFAULT_API_URL}/v1${path}`, {
    ...init,
    headers: { ...init.headers, authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  });
  if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `Request failed (${r.status})`);
  return r.status === 204 ? undefined : r.json();
}

async function status(): Promise<Status> {
  const s = await getStored();
  return {
    signedIn: !!s.token,
    online: control.online,
    apiUrl: s.apiUrl ?? DEFAULT_API_URL,
    webUrl: s.webUrl ?? 'https://kortix.com',
    browser: hub.browser ?? s.browser,
    attachments: [...hub.all.values()].map((a) => ({
      attachmentId: a.rec.attachmentId, sessionId: a.rec.sessionId, title: a.title, paused: a.paused,
    })),
  };
}

async function connectFlow(apiUrl?: string) {
  await signIn(apiUrl);
  control.stop();
  await control.connect();
  if (!(await control.ready())) throw new Error('Signed in, but Kortix did not answer. Try again.');
  return status();
}

// ─── messages from pages and overlays ────────────────────────────────────────

chrome.runtime.onMessage.addListener((m: PageMessage, sender, reply) => {
  const run = async (): Promise<unknown> => {
    await boot;
    switch (m.kortix) {
      case 'status': return status();
      case 'signin': return connectFlow(m.apiUrl);
      case 'signout': {
        await hub.endAll('closed');
        control.stop();
        await signOutLocal();
        return status();
      }
      case 'patch': {
        const { browserId } = await getStored();
        const b = await api(`/browsers/${browserId}`, { method: 'PATCH', body: JSON.stringify(m.body) });
        await hub.patchBrowser(b);
        return status();
      }
      case 'stop': return void (await hub.all.get(m.attachmentId)?.end('stopped'));
      case 'add-tab': return void (await hub.all.get(m.attachmentId)?.addToGroup(m.tabId));
      case 'consent-info': return hub.consentInfo(m.attachmentId);
      case 'consent': return hub.decide(m.attachmentId, m.decision);
      case 'overlay-pause': {
        const a = sender.tab && hub.byTab(sender.tab);
        return void a?.setPaused(!a.paused);
      }
      case 'overlay-stop': {
        const a = sender.tab && hub.byTab(sender.tab);
        return void (await a?.end('stopped'));
      }
    }
  };
  run().then(reply, (e: Error) => reply({ error: e.message }));
  return true;
});

// ─── web → extension (protocol.md §10) ───────────────────────────────────────

const HOST_API: Record<string, string> = {
  'https://kortix.com': 'https://api.kortix.com',
  'https://www.kortix.com': 'https://api.kortix.com',
  'https://dev.kortix.com': 'https://dev-api.kortix.com',
  'https://staging.kortix.com': 'https://staging-api.kortix.com',
};

chrome.runtime.onMessageExternal.addListener((m: { type?: string; apiUrl?: string }, sender, reply) => {
  const run = async () => {
    await boot;
    const s = await getStored();
    if (m?.type === 'kortix.ping') {
      return { ok: true, version: chrome.runtime.getManifest().version, connected: !!s.token && control.online, apiUrl: s.apiUrl ?? null, browserId: s.browserId ?? null };
    }
    if (m?.type === 'kortix.connect') {
      const origin = sender.origin ?? '';
      let api = HOST_API[origin];
      if (!api && new URL(origin).hostname === 'localhost' && m.apiUrl) {
        const u = new URL(m.apiUrl);
        if (u.hostname === 'localhost') api = normalizeApiUrl(m.apiUrl);
      }
      if (!api) return { ok: false, error: 'This site cannot connect a browser.' };
      const st = await connectFlow(api);
      return { ok: true, browserId: st.browser?.id ?? null };
    }
    return { ok: false, error: 'Unknown message.' };
  };
  run().then(reply, (e: Error) => reply({ ok: false, error: e.message }));
  return true;
});

