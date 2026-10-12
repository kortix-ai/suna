// Real proof, run manually: bun run scripts/smoke.ts  (needs `bun run build` first)
// Headless Chrome for Testing + the built extension + a fake Kortix API/kortixd,
// driven by the real agent-browser CLI. Exits 1 on the first failed assertion.
import { mkdtempSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const app = join(import.meta.dir, '..');
const CHROME = join(process.env.HOME!, 'Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
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
const web = Bun.serve({ port: 0, fetch: () => new Response(Bun.file(join(app, 'scripts/fixtures/form.html')), { headers: { 'content-type': 'text/html' } }) });

// ─── fake API (control socket + bridge) and fake kortixd CDP endpoint ────────
const frames: any[] = [];
let control: any, bridge: any;
const clients = new Map<string, any>();
let nextClient = 1;
const api = Bun.serve<{ kind: string }>({
  port: 0,
  fetch(req, srv) {
    const u = new URL(req.url);
    if (u.pathname === '/v1/browser/ws' && srv.upgrade(req, { data: { kind: 'control' } })) return;
    if (u.pathname.endsWith('/kortix/browser/bridge')) {
      if (u.searchParams.get('token') !== 'test' || u.searchParams.get('ticket') !== 'T1') return new Response('no', { status: 401 });
      if (srv.upgrade(req, { data: { kind: 'bridge' } })) return;
    }
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
          ws.send(JSON.stringify({ type: 'auth_ok', webUrl: 'https://kortix.test', browser: {
            id: 'b1', name: `${f.info.brand} · ${f.info.os}`, brand: f.info.brand, os: f.info.os, profileLabel: null,
            extensionVersion: f.info.extensionVersion, accessMode: 'always', tabScope: 'own', online: true, lastSeenAt: null,
            createdAt: new Date().toISOString(), activeSessions: [] } }));
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
    message(ws, raw) { bridge?.send(JSON.stringify({ c: ws.data.c, m: JSON.parse(String(raw)) })); },
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
  const p = Bun.spawn(['agent-browser', '--session', 'smoke', '--cdp', String(cdp.port), ...args], { stdout: 'pipe', stderr: 'pipe' });
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
  await until('stored browserId', async () => (await sw!.eval(`chrome.storage.local.get('browserId').then(r => r.browserId)`)) === 'b1');
  check('control: browserId stored from auth_ok', true);

  control.send(JSON.stringify({ type: 'attach', attachmentId: 'a1', sessionId: 's1', sessionTitle: 'Smoke test', projectId: 'p1',
    projectName: 'Smoke project', bridgePath: '/v1/p/x/8000/kortix/browser/bridge?ticket=T1', ticket: 'T1', consent: false }));
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
  const n = await sw.eval(`chrome.tabs.query({}).then(t => t.filter(x => x.groupId !== -1).length)`);
  check('the new tab joined the group', n === 2, String(n));
  r = await ab('tab', 'close');
  check('tab close', r.code === 0, r.out);
  await sleep(500);
  const n2 = await sw.eval(`chrome.tabs.query({}).then(t => t.filter(x => x.groupId !== -1).length)`);
  check('one tab left in the group after close', n2 === 1, String(n2));

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

  // Popup: opened as a tab, it reads status through the worker.
  await fetch(`http://127.0.0.1:${port}/json/new?chrome-extension://${EXT_ID}/popup.html`, { method: 'PUT' });
  const pop = await until('popup page', async () => (await targets()).find((t) => t.url.endsWith('/popup.html')));
  const pp = await Cdp.open(pop.webSocketDebuggerUrl);
  await until('popup renders sessions', async () => ((await pp.tryEval(`document.getElementById('sessions').textContent`)) ?? '').includes('Smoke test'));
  check('popup: browser name, online, and the session with Stop', (await pp.eval(`document.getElementById('bname').textContent`)).includes('·')
    && (await pp.eval(`document.getElementById('state').textContent`)) === 'Online'
    && (await pp.eval(`!!document.querySelector('#sessions .session button')`)) === true);
  check('popup: access mode "Always" and tabs "Own tabs" pressed', (await pp.eval(
    `document.querySelector('#mode [aria-pressed=true]').textContent + '/' + document.querySelector('#scope [aria-pressed=true]').textContent`)) === 'Always/Own tabs');
  pp.close();
  await fetch(`http://127.0.0.1:${port}/json/close/${pop.id}`);

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
    projectName: 'Smoke project', bridgePath: '/v1/p/x/8000/kortix/browser/bridge?ticket=T1', ticket: 'T1', consent: true });
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
