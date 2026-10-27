// Real proof, run manually: bun run scripts/smoke.ts  (needs `bun run build` first)
// Headless Chrome for Testing + the built extension + a fake Kortix API/kortixd,
// driven by the real agent-browser CLI. Exits 1 on the first failed assertion.
import { mkdtempSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

const app = join(import.meta.dir, '..');
// Chrome for Testing from the repo's Playwright (`npx playwright install chromium`).
// KORTIX_SMOKE_CHROME points at another Chrome build.
const CHROME = process.env.KORTIX_SMOKE_CHROME || chromium.executablePath();
const EXT_ID = 'gefbbnjgoiljpbnalgafbhbfdhikgjek';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n      ${detail}`}`);
  if (!ok) failures++;
};
async function until<T>(what: string, fn: () => T | undefined | Promise<T | undefined>, ms = 15000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(100); }
  throw new Error(`timeout: ${what}`);
}

// ─── static page ─────────────────────────────────────────────────────────────
// /auth/panel, /panel and /projects/** stand in for the Kortix web app inside the side panel (panel sign-in contract).
const handoffs: { hash: string; origin: string }[] = [];
// Every message the fake /panel page got from the extension (protocol.md §11).
const panelReports: any[] = [];
const html = (body: string, headers: Record<string, string> = {}) => new Response(body, { headers: { 'content-type': 'text/html', ...headers } });
const web = Bun.serve({
  port: 0,
  fetch(req) {
    const u = new URL(req.url);
    if (u.pathname === '/report') { handoffs.push({ hash: u.searchParams.get('hash') ?? '', origin: u.searchParams.get('origin') ?? '' }); return new Response('ok'); }
    if (u.pathname === '/panel-report') return req.json().then((m) => { panelReports.push(m); return new Response('ok'); });
    // The new chat: hello; on the first tab, list tabs and read it; on a right-click context, hand that tab to session s5.
    if (u.pathname === '/panel') return html(`<script>
      const ext = 'chrome-extension://${EXT_ID}';
      let asked = false;
      addEventListener('message', (e) => {
        if (e.origin !== ext) return;
        fetch('/panel-report', { method: 'POST', body: JSON.stringify(e.data) });
        if (e.data?.type === 'kortix.panel.tab' && e.data.tab && !asked) {
          asked = true;
          parent.postMessage({ type: 'kortix.panel.tabs', requestId: 'T1' }, ext);
          parent.postMessage({ type: 'kortix.panel.read', requestId: 'R1', tabIds: [e.data.tab.id] }, ext);
        }
        if (e.data?.type === 'kortix.panel.context' && e.data.tab) {
          parent.postMessage({ type: 'kortix.panel.act', tabId: e.data.tab.id }, ext);
          parent.postMessage({ type: 'kortix.panel.route', path: '/projects/p5/sessions/s5', sessionId: 's5' }, ext);
        }
      });
      parent.postMessage({ type: 'kortix.panel.hello' }, ext);
    </script>panel`);
    if (u.pathname === '/auth/panel') return html(`<script>
      const ext = 'chrome-extension://${EXT_ID}';
      addEventListener('message', (e) => {
        if (e.origin !== ext || e.data?.type !== 'kortix.panel.session') return;
        fetch('/report?hash=' + encodeURIComponent(e.data.tokenHash) + '&origin=' + encodeURIComponent(e.origin)).then(() => location.replace(${JSON.stringify(u.searchParams.get('next') ?? '/projects')}));
      });
      parent.postMessage({ type: 'kortix.panel.needSession' }, ext);
    </script>signing in`);
    if (u.pathname.startsWith('/projects')) return html(`<script>
      parent.postMessage({ type: 'kortix.identity', userId: 'u-web', email: 'web@example.test' }, '*');
    </script>app ${u.pathname}`);
    return new Response(Bun.file(join(app, 'scripts/fixtures/form.html')), { headers: { 'content-type': 'text/html' } });
  },
});

// ─── fake API (control socket + bridge) and fake kortixd CDP endpoint ────────
const frames: any[] = [];
let control: any, bridge: any;
const clients = new Map<string, any>();
const panelSessionCalls: string[] = [];
const chromeRow: Record<string, unknown> = {};
let nextClient = 1;
const api = Bun.serve<{ kind: string }>({
  port: 0,
  fetch(req, srv) {
    const u = new URL(req.url);
    if (u.pathname === '/v1/chrome/ws' && srv.upgrade(req, { data: { kind: 'control' } })) return;
    if (u.pathname.endsWith('/kortix/chrome/bridge')) {
      if (u.searchParams.get('token') !== 'test' || u.searchParams.get('ticket') !== 'T1') return new Response('no', { status: 401 });
      if (srv.upgrade(req, { data: { kind: 'bridge' } })) return;
    }
    if (u.pathname === '/v1/chrome/connections/b1' && req.method === 'PATCH') {
      return req.json().then((body) => { Object.assign(chromeRow, body); return Response.json(chromeRow); });
    }
    if (u.pathname === '/v1/chrome/panel-session' && req.method === 'POST') {
      panelSessionCalls.push(req.headers.get('authorization') ?? '');
      return req.headers.get('authorization') === 'Bearer test' ? Response.json({ tokenHash: 'HASH-1' }) : Response.json({ error: 'chrome_panel_forbidden' }, { status: 403 });
    }
    if (u.pathname === '/v1/accounts/me' && req.headers.get('authorization') === 'Bearer test') return Response.json({ user_id: 'u-ext', email: 'ext@example.test' });
    return new Response('not found', { status: 404 });
  },
  websocket: {
    open(ws) { if (ws.data.kind === 'bridge') bridge = ws; else control = ws; },
    message(ws, raw) {
      const f = JSON.parse(String(raw));
      if (ws.data.kind === 'control') {
        frames.push(f);
        if (f.type === 'auth') {
          if (f.token !== 'test') return ws.close(4001);
          ws.send(JSON.stringify({ type: 'auth_ok', webUrl: `http://127.0.0.1:${web.port}`, chrome: Object.assign(chromeRow, {
            id: 'b1', name: `${f.info.brand} · ${f.info.os}`, brand: f.info.brand, os: f.info.os, profileLabel: null,
            extensionVersion: f.info.extensionVersion, accessMode: 'always', tabScope: 'own', online: true, lastSeenAt: null,
            createdAt: new Date().toISOString(), activeSessions: [] }) }));
        }
        if (f.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
      } else {
        frames.push({ bridge: f });
        if (f.pong || f.ping || f.hello) return;
        clients.get(f.c)?.send(JSON.stringify(f.m));
      }
    },
  },
});
const cdp: ReturnType<typeof Bun.serve<{ c: string }>> = Bun.serve<{ c: string }>({
  port: 0,
  fetch(req, srv): Response | undefined {
    const u = new URL(req.url);
    if (u.pathname === '/json/version') return Response.json({
      Browser: 'Kortix/Chrome', 'Protocol-Version': '1.3', 'User-Agent': 'Kortix',
      webSocketDebuggerUrl: `ws://127.0.0.1:${cdp.port}/devtools/browser/kortix` });
    if (u.pathname === '/json' || u.pathname === '/json/list') return Response.json([]);
    if (u.pathname.startsWith('/devtools/') && srv.upgrade(req, { data: { c: String(nextClient++) } })) return;
    return new Response('not found', { status: 404 });
  },
  websocket: {
    open(ws) {
      if (!bridge) return ws.close(1011, 'No browser attached');
      clients.set(ws.data.c, ws);
      bridge.send(JSON.stringify({ c: ws.data.c, open: true }));
    },
    async message(ws, raw) {
      let m = JSON.parse(String(raw));
      // What kortixd does (services/chrome withSandboxFiles): sandbox paths become file bytes.
      if (m.method === 'DOM.setFileInputFiles') {
        const { files, ...target } = m.params;
        const out = await Promise.all((files as string[]).map(async (p) => ({ name: p.split('/').pop(), type: Bun.file(p).type, data: Buffer.from(await Bun.file(p).arrayBuffer()).toString('base64') })));
        m = { ...m, method: 'Kortix.setFileInputFiles', params: { ...target, files: out } };
      }
      bridge?.send(JSON.stringify({ c: ws.data.c, m }));
    },
    close(ws) { clients.delete(ws.data.c); bridge?.send(JSON.stringify({ c: ws.data.c, close: true })); },
  },
});

// ─── Chrome ──────────────────────────────────────────────────────────────────
const port = 9222 + Math.floor(Math.random() * 500);
const profile = mkdtempSync(join(tmpdir(), 'kortix-smoke-'));
const chrome = Bun.spawn([CHROME, '--headless=new', `--load-extension=${join(app, 'dist')}`, `--disable-extensions-except=${join(app, 'dist')}`,
  `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdout: 'ignore', stderr: 'ignore' });

class Cdp {
  private id = 0; private pending = new Map<number, (m: any) => void>(); private ws!: WebSocket;
  static async open(url: string) {
    const c = new Cdp(); c.ws = new WebSocket(url);
    await new Promise((r) => (c.ws.onopen = r));
    c.ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data));
      if (m.method === 'Runtime.exceptionThrown') console.log('  [sw exception]', m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
      if (m.method === 'Runtime.consoleAPICalled' && process.env.SMOKE_VERBOSE) console.log('  [console]', m.params.args.map((a: any) => a.value ?? a.description).join(' '));
      c.pending.get(m.id)?.(m);
    };
    c.ws.send(JSON.stringify({ id: 0, method: 'Runtime.enable' }));
    return c;
  }
  /** eval that returns undefined instead of throwing (page still loading). */
  async tryEval(expression: string) { try { return await this.eval(expression); } catch { return undefined; } }
  async eval(expression: string) {
    const id = ++this.id;
    const done = new Promise<any>((r) => this.pending.set(id, r));
    this.ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
    const m = await done;
    if (m.error || m.result?.exceptionDetails) throw new Error(JSON.stringify(m.error ?? m.result.exceptionDetails));
    return m.result.result.value;
  }
  close() { this.ws.close(); }
}
const targets = async (): Promise<any[]> => {
  try { return (await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as any[]; } catch { return []; }
};

const ab = async (...args: string[]) => {
  const t0 = Date.now();
  const p = Bun.spawn(['agent-browser', '--session', `smoke-${port}`, '--cdp', String(cdp.port), ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  console.log(`  $ agent-browser ${args.join(' ')}  -> exit ${code} (${Date.now() - t0} ms)\n${(out + err).trim().split('\n').slice(0, 8).map((l) => '      ' + l).join('\n')}`);
  return { out: out + err, code };
};

let sw: Cdp | undefined;
let opened = false;
try {
  // Seed credentials in the extension service worker.
  // The worker target can show up before its JS realm has `chrome`: retry.
  sw = await until('extension service worker', async () => {
    const t = (await targets()).find((x) => x.type === 'service_worker' && x.url.includes(EXT_ID));
    if (!t) return undefined;
    const c = await Cdp.open(t.webSocketDebuggerUrl);
    try {
      await c.eval(`chrome.storage.local.set({ apiUrl: 'http://127.0.0.1:${api.port}', token: 'test' })`);
      return c;
    } catch { c.close(); return undefined; }
  });
  check('extension loads with the pinned ID', true);
  await until('control socket auth', () => frames.find((f) => f.type === 'auth'));
  const auth = frames.find((f) => f.type === 'auth');
  check('control: auth frame carries token and identity', auth.token === 'test' && auth.info.extensionVersion === '1.0.0' && !!auth.info.os, JSON.stringify(auth));
  await until('stored chromeId', async () => (await sw!.eval(`chrome.storage.local.get('chromeId').then(r => r.chromeId)`)) === 'b1');
  check('control: chromeId stored from auth_ok', true);

  control.send(JSON.stringify({ type: 'attach', attachmentId: 'a1', sessionId: 's1', sessionTitle: 'Smoke test', projectId: 'p1',
    projectName: 'Smoke project', bridgePath: '/v1/p/x/8000/kortix/chrome/bridge?ticket=T1', ticket: 'T1', consent: false }));
  await until('attached frame', () => frames.find((f) => f.type === 'attached' && f.attachmentId === 'a1'));
  check('attach: bridge dialed, `attached` sent', !!bridge);
  check('bridge: hello frame sent', frames.some((f) => f.bridge?.hello?.tabScope === 'own'));

  const url = `http://127.0.0.1:${web.port}/form.html`;
  opened = true;
  let r = await ab('open', url);
  check('agent-browser open', r.code === 0, r.out);
  r = await ab('snapshot', '-i');
  const box = /textbox[^\n]*\[ref=(e\d+)\]/.exec(r.out)?.[1], btn = /button "Greet"[^\n]*\[ref=(e\d+)\]/.exec(r.out)?.[1];
  check('snapshot -i lists the textbox and the button', !!box && !!btn, r.out);
  r = await ab('fill', `@${box}`, 'Kortix');
  check('fill', r.code === 0, r.out);
  r = await ab('click', `@${btn}`);
  check('click', r.code === 0, r.out);
  r = await ab('get', 'text', '#out');
  check('click had an effect on the page ("Hello Kortix")', r.out.includes('Hello Kortix'), r.out);
  r = await ab('get', 'title');
  check('get title', r.out.includes('Kortix Smoke Form'), r.out);
  const shot = join(profile, 'shot.png');
  r = await ab('screenshot', shot);
  check('screenshot writes a PNG', existsSync(shot) && statSync(shot).size > 1000, r.out);

  // Visible state.
  const groups = await sw.eval(`chrome.tabGroups.query({}).then(g => g.map(x => ({ title: x.title, color: x.color })))`);
  check('tab group "Kortix · Smoke test", blue', groups.some((g: any) => g.title === 'Kortix · Smoke test' && g.color === 'blue'), JSON.stringify(groups));
  const page = (await targets()).find((t) => t.type === 'page' && t.url.includes('form.html'));
  check('the page is in the Kortix group', !!page);
  const pg = await Cdp.open(page.webSocketDebuggerUrl);
  const overlay = (js: string) => pg.eval(`(() => { const r = document.getElementById('kortix-overlay-host')?.shadowRoot; return r ? (${js}) : null })()`);
  check('overlay host element exists in the page', (await pg.eval(`!!document.getElementById('kortix-overlay-host')`)) === true);
  check('overlay: control bar says "Kortix is working"', (await overlay(`r.querySelector('.msg').textContent`)) === 'Kortix is working');
  check('overlay: glow on and agent cursor moved after the click', (await overlay(`r.querySelector('.glow').classList.contains('on') && r.querySelector('.cursor').style.transform.startsWith('translate(')`)) === true);

  // Tabs.
  r = await ab('tab', 'new', `${url}?second=1`);
  check('tab new', r.code === 0, r.out);
  r = await ab('tab', 'list');
  check('tab list shows two tabs', (r.out.match(/form\.html/g) ?? []).length >= 2, r.out);
  const n = await sw.eval(`chrome.tabGroups.query({ title: 'Kortix · Smoke test' }).then(([g]) => chrome.tabs.query({ groupId: g.id })).then(t => t.length)`);
  check('the new tab joined the group', n === 2, String(n));
  r = await ab('tab', 'close');
  check('tab close', r.code === 0, r.out);
  await sleep(500);
  const n2 = await sw.eval(`chrome.tabGroups.query({ title: 'Kortix · Smoke test' }).then(([g]) => chrome.tabs.query({ groupId: g.id })).then(t => t.length)`);
  check('one tab left in the group after close', n2 === 1, String(n2));

  // Overlay: bar docks bottom-right; dark tokens apply; the agent label is a blue chip with white text.
  check('overlay: bar docks bottom-right', (await overlay(`(() => { const b = r.querySelector('.bar').getBoundingClientRect(); return Math.abs(innerWidth - 16 - b.right) < 2 && Math.abs(innerHeight - 16 - b.bottom) < 2 && !r.querySelector('.bar').classList.contains('top'); })()`)) === true);
  check('overlay: agent label is a fixed blue chip with white text', (await overlay(`(() => { const c = getComputedStyle(r.querySelector('.label')); return c.backgroundColor === 'rgb(0, 153, 255)' && c.color === 'rgb(255, 255, 255)'; })()`)) === true);
  check('overlay: tokens resolve in the shadow tree', (await overlay(`getComputedStyle(r.querySelector('.bar')).backgroundColor !== 'rgba(0, 0, 0, 0)'`)) === true);

  // Take over, then resume. Refs reset with the tab switch: snapshot again.
  r = await ab('snapshot', '-i');
  const btn2 = /button "Greet"[^\n]*\[ref=(e\d+)\]/.exec(r.out)?.[1] ?? btn;
  await overlay(`r.querySelector('.pause').click()`);
  await until('overlay shows paused', async () => (await overlay(`r.querySelector('.msg').textContent`)) === 'You have control');
  r = await ab('click', `@${btn2}`);
  check('paused: Input is rejected with the take-over message', r.code !== 0 && /took over/i.test(r.out), r.out);
  await overlay(`r.querySelector('.pause').click()`);
  await until('overlay resumed', async () => (await overlay(`r.querySelector('.msg').textContent`)) === 'Kortix is working');
  r = await ab('click', `@${btn2}`);
  check('resumed: click works again', r.code === 0, r.out);

  // The overlay must stay out of the agent's accessibility tree: it must never click Stop for itself.
  r = await ab('snapshot', '-i');
  check('overlay controls are hidden from the agent snapshot', !/Take over|"Stop"|region "Kortix"/.test(r.out), r.out);
  r = await ab('close');
  check('agent-browser close', r.code === 0, r.out);
  opened = false;

  // Stop.
  await overlay(`r.querySelector('.stop').click()`);
  const det = await until('detached frame', () => frames.find((f) => f.type === 'detached'));
  check('Stop sends detached{stopped}', det.reason === 'stopped' && det.attachmentId === 'a1', JSON.stringify(det));
  await sleep(500);
  const left = await sw.eval(`chrome.tabGroups.query({}).then(g => g.length)`);
  check('Stop removes the tab group', left === 0, String(left));
  check('Stop removes the overlay', (await pg.eval(`!document.getElementById('kortix-overlay-host')`)) === true);
  pg.close();

  // Consent: Allow, then Deny.
  const attachFrame = (id: string) => ({ type: 'attach', attachmentId: id, sessionId: `s-${id}`, sessionTitle: `Consent ${id}`, projectId: 'p1',
    projectName: 'Smoke project', bridgePath: '/v1/p/x/8000/kortix/chrome/bridge?ticket=T1', ticket: 'T1', consent: true });
  const consentPage = async (id: string) => {
    const t = await until(`consent window ${id}`, async () => (await targets()).find((x) => x.url.includes(`consent.html?id=${id}`)));
    const c = await Cdp.open(t.webSocketDebuggerUrl);
    await until('consent text', async () => ((await c.tryEval(`document.getElementById('body').textContent`)) ?? '').includes(`Consent ${id}`));
    return c;
  };
  control.send(JSON.stringify(attachFrame('c1')));
  let cp = await consentPage('c1');
  check('consent window names the session, project and browser', (await cp.eval(`document.getElementById('body').textContent + document.getElementById('title').textContent`)).includes('Smoke project'));
  frames.length = 0;
  await cp.eval(`document.getElementById('session').click()`);
  await until('consent frame', () => frames.find((f) => f.type === 'consent'));
  check('consent: "Allow for this session" sends consent{session}', frames.find((f) => f.type === 'consent').decision === 'session');
  await until('attached after consent', () => frames.find((f) => f.type === 'attached' && f.attachmentId === 'c1'));
  check('consent: bridge dials only after Allow', true);
  control.send(JSON.stringify({ type: 'detach', attachmentId: 'c1' }));
  await until('detached after api detach', () => frames.find((f) => f.type === 'detached' && f.attachmentId === 'c1'));
  check('api detach ends the attachment (reason closed)', frames.find((f) => f.type === 'detached' && f.attachmentId === 'c1').reason === 'closed');

  frames.length = 0;
  control.send(JSON.stringify(attachFrame('c2')));
  cp = await consentPage('c2');
  await cp.eval(`document.getElementById('deny').click()`);
  await until('deny frame', () => frames.find((f) => f.type === 'consent'));
  await sleep(500);
  check('consent: Deny sends consent{deny} and never attaches', frames.find((f) => f.type === 'consent').decision === 'deny' && !frames.some((f) => f.type === 'attached'));

  // All tabs, two windows, and a browser whose chrome.tabs.group fails the way
  // Dia's does ("Tab not found for session ID"): the session must still work,
  // see the user's tabs, start in a tab of its own, and never navigate theirs.
  const patched = await sw.eval(`(() => {
    const fail = () => Promise.reject(new Error('Tab not found for session ID: TabSessionID(value: 1)'));
    try { chrome.tabs.group = fail; } catch {}
    if (chrome.tabs.group !== fail) Object.defineProperty(chrome.tabs, 'group', { value: fail, configurable: true });
    return chrome.tabs.group === fail;
  })()`);
  check('setup: chrome.tabs.group fails like Dia', patched === true);
  const userA = `http://127.0.0.1:${web.port}/form.html?user=inbox`;
  const userB = `http://127.0.0.1:${web.port}/form.html?user=docs`;
  const userIds: number[] = await sw.eval(`Promise.all([chrome.windows.create({ url: '${userA}' }), chrome.windows.create({ url: '${userB}' })]).then((ws) => ws.map((w) => w.tabs[0].id))`);
  const stored = await sw.eval(`chrome.storage.local.get('chrome').then((r) => r.chrome)`);
  Object.assign(chromeRow, { tabScope: 'all' });
  control.send(JSON.stringify({ type: 'chrome', chrome: { ...stored, tabScope: 'all' } }));
  await sleep(300);
  frames.length = 0;
  control.send(JSON.stringify({ type: 'attach', attachmentId: 'a3', sessionId: 's3', sessionTitle: 'All tabs', projectId: 'p1',
    projectName: 'Smoke project', bridgePath: '/v1/p/x/8000/kortix/chrome/bridge?ticket=T1', ticket: 'T1', consent: false }));
  await until('attached a3', () => frames.find((f) => f.type === 'attached' && f.attachmentId === 'a3'));
  opened = true;
  r = await ab('tab', 'list');
  check('all tabs: tab list shows the user tabs in both windows', r.out.includes('user=inbox') && r.out.includes('user=docs'), r.out);
  const current = r.out.split('\n').find((l) => l.includes('→')) ?? '';
  check('all tabs: the agent starts in a tab of its own', current !== '' && !current.includes('user='), r.out);
  r = await ab('open', `${url}?agent=1`);
  check('no tab groups: open still works', r.code === 0, r.out);
  const after: string[] = await sw.eval(`Promise.all(${JSON.stringify(userIds)}.map((id) => chrome.tabs.get(id))).then((ts) => ts.map((t) => t.url))`);
  check('all tabs: open never navigates a user tab', after[0] === userA && after[1] === userB, JSON.stringify(after));
  r = await ab('tab', 'list');
  const docs = /\[(t\d+)\][^\n]*user=docs/.exec(r.out)?.[1];
  if (docs) await ab('tab', docs);
  r = await ab('get', 'url');
  check('all tabs: the agent can switch to and read a user tab', r.out.includes('user=docs'), r.out);
  const groupCount = await sw.eval(`chrome.tabGroups.query({}).then((g) => g.length)`);
  check('no tab groups: nothing was grouped, nothing failed', groupCount === 0, String(groupCount));
  await ab('close');
  opened = false;
  control.send(JSON.stringify({ type: 'detach', attachmentId: 'a3' }));
  await until('detached a3', () => frames.find((f) => f.type === 'detached' && f.attachmentId === 'a3'));

  // ─── side panel ─────────────────────────────────────────────────────────────
  const webOrigin = `http://127.0.0.1:${web.port}`;
  const openTab = async (u: string, match: string) => {
    await sw!.eval(`chrome.tabs.create({ url: '${u}', active: false })`);
    const t = await until(`tab ${match}`, async () => (await targets()).find((x) => x.type === 'page' && x.url.startsWith(match)));
    return Cdp.open(t.webSocketDebuggerUrl);
  };
  control.send(JSON.stringify({ type: 'attach', attachmentId: 'a4', sessionId: 's4', sessionTitle: 'Panel test', projectId: 'p4',
    projectName: 'Smoke project', bridgePath: '/v1/p/x/8000/kortix/chrome/bridge?ticket=T1', ticket: 'T1', consent: false }));
  await until('attached a4', () => frames.find((f) => f.type === 'attached' && f.attachmentId === 'a4'));
  // The panel's window shows a readable page: the new chat's tab chip.
  await sw!.eval(`chrome.tabs.create({ url: '${webOrigin}/form.html?user=panel', active: true })`);
  await until('panel page tab', async () => (await targets()).find((x) => x.type === 'page' && x.url.includes('user=panel')));
  const panel = await openTab(`chrome-extension://${EXT_ID}/sidepanel.html`, `chrome-extension://${EXT_ID}/sidepanel.html`);
  const bname = await until('panel header', async () => {
    const t = await panel.tryEval(`document.getElementById('bname')?.textContent`);
    return t ? t : undefined;
  });
  check('panel: header shows the browser name', /·/.test(bname), bname);
  await until('panel online dot', async () => (await panel.tryEval(`document.getElementById('dot').classList.contains('on')`)) ? true : undefined);
  check('panel: online dot is on', true);
  await until('panel handoff', () => handoffs[0]);
  const src0 = await panel.eval(`document.getElementById('app').src`);
  check('panel: iframe starts at /auth/panel?next=/panel (a new chat every time)', src0 === `${webOrigin}/auth/panel?next=%2Fpanel`, src0);
  check('panel sign-in: one POST /v1/chrome/panel-session with the OAuth token', panelSessionCalls.length === 1 && panelSessionCalls[0] === 'Bearer test', JSON.stringify(panelSessionCalls));
  check('panel sign-in: the page got the token hash from the extension origin', handoffs[0].hash === 'HASH-1' && handoffs[0].origin === `chrome-extension://${EXT_ID}`, JSON.stringify(handoffs));
  const tabMsg = await until('panel channel: tab', () => panelReports.find((m) => m.type === 'kortix.panel.tab' && m.tab));
  check('panel channel: hello gets the active tab of the panel window', tabMsg.tab.url.includes('user=panel') && tabMsg.tab.readable === true, JSON.stringify(tabMsg));
  const tabsMsg = await until('panel channel: tabs', () => panelReports.find((m) => m.type === 'kortix.panel.tabs.result'));
  check('panel channel: tabs lists the window tabs', tabsMsg.requestId === 'T1' && tabsMsg.tabs.some((t: any) => t.id === tabMsg.tab.id), JSON.stringify(tabsMsg).slice(0, 300));
  const readMsg = await until('panel channel: read', () => panelReports.find((m) => m.type === 'kortix.panel.read.result'));
  check('panel channel: read returns the tab text', readMsg.requestId === 'R1' && readMsg.pages[0]?.tabId === tabMsg.tab.id && /Smoke form/.test(readMsg.pages[0]?.text ?? ''), JSON.stringify(readMsg).slice(0, 300));
  // Right-click "Ask Kortix about this selection" stores the context; the open panel hands it to the page.
  await sw!.eval(`chrome.storage.session.set({ panelContext: { tabId: ${tabMsg.tab.id}, quote: 'Smoke quote', at: Date.now() } })`);
  const ctxMsg = await until('panel channel: context', () => panelReports.find((m) => m.type === 'kortix.panel.context'));
  check('panel channel: a right-click context reaches the page with its quote and tab', ctxMsg.quote === 'Smoke quote' && ctxMsg.tab?.id === tabMsg.tab.id, JSON.stringify(ctxMsg));
  check('panel channel: the context is consumed once', (await sw!.eval(`chrome.storage.session.get('panelContext').then((v) => v.panelContext === undefined)`)) === true);
  // Act: the page handed the tab to s5 before s5 attached; the attach puts the tab in s5's tabs.
  await until('handed tab stored', async () => (await sw!.eval(`chrome.storage.session.get('handedTabs').then((v) => v.handedTabs?.s5 ?? 0)`)) || undefined);
  control.send(JSON.stringify({ type: 'attach', attachmentId: 'a5', sessionId: 's5', sessionTitle: 'Act test', projectId: 'p5',
    projectName: 'Smoke project', bridgePath: '/v1/p/x/8000/kortix/chrome/bridge?ticket=T1', ticket: 'T1', consent: false }));
  await until('attached a5', () => frames.find((f) => f.type === 'attached' && f.attachmentId === 'a5'));
  const a5Tabs = await sw!.eval(`chrome.storage.session.get('attachments').then((v) => JSON.stringify(v.attachments.find((a) => a.attachmentId === 'a5')?.tabIds ?? []))`);
  check('panel Act: the handed tab joins the session that attaches', JSON.parse(a5Tabs).includes(tabMsg.tab.id), a5Tabs);
  check('panel Act: the hand-off is used once', (await sw!.eval(`chrome.storage.session.get('handedTabs').then((v) => v.handedTabs?.s5 === undefined)`)) === true);
  control.send(JSON.stringify({ type: 'detach', attachmentId: 'a5' }));
  await until('detached a5', () => frames.find((f) => f.type === 'detached' && f.attachmentId === 'a5'));
  // A needSession that does not come from the web page's frame is ignored.
  await panel.eval(`postMessage({ type: 'kortix.panel.needSession' }, '*')`);
  await sleep(600);
  check('panel sign-in: a message from another source triggers no request', panelSessionCalls.length === 1, String(panelSessionCalls.length));
  await until('chip', async () => (await panel.eval(`document.querySelector('.chip-open')?.textContent`)) === 'Panel test' ? true : undefined);
  check('panel: chip "Panel test" shows while a session is attached, with Add this tab and Stop', (await panel.eval(`[...document.querySelectorAll('.chip button')].map((b) => b.textContent).join('|')`)) === 'Panel test|Add this tab|Stop');
  await panel.eval(`document.querySelector('.chip-open').click()`);
  check('panel: chip opens the session in the iframe', (await panel.eval(`document.getElementById('app').src`)) === `${webOrigin}/projects/p4/sessions/s4`);
  await until('account warning', async () => (await panel.eval(`!document.getElementById('warn').hidden`)) ? true : undefined);
  check('panel: different web account shows the warning with Sign in as and Dismiss', /web@example\.test/.test(await panel.eval(`document.getElementById('warn-text').textContent`)) && (await panel.eval(`/^Sign in as /.test(document.getElementById('switch')?.textContent ?? '') && !!document.getElementById('dismiss')`)));
  await panel.eval(`document.getElementById('menu-btn').click()`);
  check('panel: menu lists Kortix in Chrome settings and Sign out', (await panel.eval(`[...document.querySelectorAll('#menu button')].map((b) => b.textContent).join('|')`)) === 'Kortix in Chrome settings|Sign out');
  // Focus survives a refresh: the 5 s poll and storage events must not rebuild the chip row.
  await panel.eval(`document.querySelector('.chip-stop').focus()`);
  await sleep(700);
  check('panel: focus on a chip button survives a refresh', (await panel.eval(`document.activeElement?.classList.contains('chip-stop')`)) === true);
  panel.close();
  control.send(JSON.stringify({ type: 'detach', attachmentId: 'a4' }));
  await until('detached a4', () => frames.find((f) => f.type === 'detached' && f.attachmentId === 'a4'));
  const opts = await openTab(`chrome-extension://${EXT_ID}/options.html`, `chrome-extension://${EXT_ID}/options.html`);
  await until('options email', async () => (await opts.tryEval(`document.getElementById('email').textContent`)) === 'ext@example.test' ? true : undefined);
  check('options: browser name, online, email', (await opts.eval(`document.getElementById('bname').textContent`)).includes('·') && (await opts.eval(`document.getElementById('state').textContent`)) === 'Online');
  check('options: access and tabs are radiogroups with the web labels', (await opts.eval(`[...document.querySelectorAll('#mode button')].map((b) => b.textContent).join('|') + '/' + [...document.querySelectorAll('#scope button')].map((b) => b.textContent).join('|') + '/' + document.getElementById('mode').getAttribute('role')`)) === 'Without asking|Ask first|Off/All tabs|Only tabs it opens/radiogroup');
  check('options: access "Without asking" and tabs "All tabs" checked', (await opts.eval(`document.querySelector('#mode [aria-checked=true]').textContent + '/' + document.querySelector('#scope [aria-checked=true]').textContent`)) === 'Without asking/All tabs');
  check('options: both shortcuts listed', (await opts.eval(`document.getElementById('key').textContent.length > 0 && document.getElementById('stopkey').textContent.length > 0`)) === true);
  await opts.eval(`document.querySelector('#mode button[data-v=ask]').focus()`);
  await opts.eval(`document.getElementById('mode').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))`);
  await until('arrow key picks the next radio', async () => ((await opts.eval(`document.querySelector('#mode [aria-checked=true]').textContent`)) === 'Off' ? true : undefined));
  check('options: arrow keys move through the radios and patch', true);
  await opts.eval(`document.querySelector('#mode button[data-v=always]').click()`);
  await until('access back to Without asking', async () => ((await opts.eval(`document.querySelector('#mode [aria-checked=true]').textContent`)) === 'Without asking' ? true : undefined));
  opts.close();

  // F1: a confirm() the agent opens must not deadlock agent-browser.
  frames.length = 0;
  control.send(JSON.stringify({ type: 'attach', attachmentId: 'a5', sessionId: 's4', sessionTitle: 'Dialogs and tabs', projectId: 'p1',
    projectName: 'Smoke project', bridgePath: '/v1/p/x/8000/kortix/chrome/bridge?ticket=T1', ticket: 'T1', consent: false }));
  await until('attached a5', () => frames.find((f) => f.type === 'attached' && f.attachmentId === 'a5'));
  opened = true;
  r = await ab('open', `${url}?dialog=1`);
  const t0 = Date.now();
  r = await ab('click', '#ask');
  check('dialogs: clicking a confirm() returns (no deadlock)', r.code === 0 && Date.now() - t0 < 15000, `${Date.now() - t0} ms: ${r.out}`);
  r = await ab('dialog', 'accept');
  r = await ab('get', 'text', '#out');
  check('dialogs: the agent answers the confirm() itself (dialog accept)', r.out.includes('confirmed'), r.out);
  // F2: back-to-back tab creation, the race Dia showed.
  const created = await Promise.all([1, 2, 3, 4].map(async (i) => (await ab('tab', 'new', `${url}?rapid=${i}`)).code));
  check('tabs: 4 back-to-back `tab new` all succeed', created.every((c) => c === 0), JSON.stringify(created));
  r = await ab('tab', 'list');
  check('tabs: all 4 are tracked afterwards', [1, 2, 3, 4].every((i) => r.out.includes(`rapid=${i}`)), r.out);
  // F7: a sandbox file reaches the page's file input as a real selection.
  const upPath = join(profile, 'kb-upload.txt');
  await Bun.write(upPath, 'hello-from-sandbox');
  r = await ab('open', `${url}?upload=1`);
  r = await ab('upload', '#file', upPath);
  check('upload: agent-browser upload succeeds', r.code === 0, r.out);
  r = await ab('get', 'text', '#picked');
  check('upload: the page received the file with its bytes', r.out.includes('kb-upload.txt:18'), r.out);
  await ab('close');
  opened = false;
  control.send(JSON.stringify({ type: 'detach', attachmentId: 'a5' }));
  await until('detached a5', () => frames.find((f) => f.type === 'detached' && f.attachmentId === 'a5'));
} catch (e) {
  failures++;
  console.log(`FAIL  ${(e as Error).message}`);
} finally {
  if (opened) await ab('close').catch(() => {});
  sw?.close();
  chrome.kill();
  web.stop(true); api.stop(true); cdp.stop(true);
  console.log(failures ? `\n${failures} check(s) failed` : '\nsmoke: all checks passed');
  process.exit(failures ? 1 : 0);
}
