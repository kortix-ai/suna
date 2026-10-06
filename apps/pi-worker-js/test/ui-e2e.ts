// THE REAL BROWSER, against pi-js.kortix.com — what the user sees, timed.
// Not curl: Chromium runs the deployed frontend, and the proof is the network
// it produces (session-shaped in-box URLs, no 503) and the DOM it paints
// (one bubble per message).
import { chromium, type Page, type Request, type Response } from '@playwright/test';

const BASE = 'https://pi-js.kortix.com';
const PROJ = process.env.KORTIX_E2E_PROJECT ?? '8781c6ce-0313-4fef-b39a-fffd8dded724';
const EMAIL = 'pt-e2e-1788648166@example.test';
const PASSWORD = 'Pt-e2e-2026!x';
const now = () => Date.now();
let pass = 0, fail = 0;
const ck = (name: string, ok: boolean, detail = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : '  ' + detail}`); ok ? pass++ : fail++; };

async function api(path: string, init: RequestInit & { token?: string } = {}) {
  const r = await fetch(`${BASE}${path}`, { ...init, headers: { 'content-type': 'application/json', ...(init.token ? { authorization: `Bearer ${init.token}` } : {}), ...(init.headers ?? {}) } });
  return r;
}

async function main() {
  // A session on the shared runner, created the way the app creates one.
  const si = await (await api('/v1/auth/sign-in/password', { method: 'POST', body: JSON.stringify({ email: EMAIL, password: PASSWORD }) })).json() as any;
  const token = si.session.access_token as string;
  // The project's onboarding wizard covers the session page until it is
  // completed; its "Open project" button would auto-send a kickoff prompt.
  // Complete it the way the SDK does (PATCH /projects/:id/onboarding).
  const ob = await api(`/v1/projects/${PROJ}/onboarding`, { method: 'PATCH', token, body: JSON.stringify({ completed: true }) });
  console.log(`  onboarding marked complete: ${ob.status}`);
  const tCreate = now();
  // E2E_SESSION reuses an existing session (a transcript already there) instead
  // of creating a fresh one — the differential for "does the loader lift when
  // there is something to hydrate".
  const sid = process.env.E2E_SESSION ?? ((await (await api(`/v1/projects/${PROJ}/sessions`, { method: 'POST', token, body: JSON.stringify({}) })).json() as any).session_id as string);
  let stage = '';
  for (let i = 0; i < 20 && stage !== 'ready'; i++) stage = (await (await api(`/v1/projects/${PROJ}/sessions/${sid}/start?wait_ms=8000`, { method: 'POST', token, body: '{}' })).json() as any).stage;
  const tReady = now() - tCreate;
  console.log(`  session ${sid}  create+ready ${tReady} ms`);

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36' });
  const page = await ctx.newPage();
  // The app's own boot timeline (apps/web/src/lib/session-timing.ts) prints
  // which readiness marks fired — runtime-ready, opencode-listed, chat-ready.
  await ctx.addInitScript(() => { try { localStorage.setItem('kortix_session_timing', '1'); } catch {} });
  const inbox: Array<{ t: number; method: string; url: string; status?: number }> = [];
  const all: Array<{ t: number; method: string; url: string; status?: number }> = [];
  page.on('request', (rq: Request) => { if (rq.url().includes('/v1/')) all.push({ t: now(), method: rq.method(), url: rq.url() }); if (rq.url().includes('/v1/p/')) inbox.push({ t: now(), method: rq.method(), url: rq.url() }); });
  page.on('response', (rs: Response) => { const a = all.find((x) => x.url === rs.url() && x.status === undefined && x.method === rs.request().method()); if (a) a.status = rs.status(); });
  const t0c = now();
  page.on('console', (m) => { const t = m.text(); if (/color:#|i18n|Download the React DevTools|_rsc/.test(t)) return; console.log(`  [+${((now() - t0c) / 1000).toFixed(1)}s console.${m.type()}] ${t.replace(/\s+/g, ' ').slice(0, 150)}`); });
  page.on('pageerror', (e) => console.log(`  [pageerror] ${String(e).slice(0, 160)}`));
  page.on('requestfailed', (rq) => console.log(`  [requestfailed] ${rq.method()} ${rq.url().slice(0, 120)} -> ${rq.failure()?.errorText}`));
  page.on('response', (rs: Response) => { const e = inbox.find((x) => x.url === rs.url() && x.status === undefined && x.method === rs.request().method()); if (e) e.status = rs.status(); });

  // Sign in exactly as the repo's browser lane does (tests/e2e/helpers/
  // session-auth.ts): Supabase's own password grant — a FULL session with
  // refresh_token and expires_at, which the app's client can refresh —
  // installed as the app's auth cookie. The API's sign-in proxy returned a
  // session the client soon called expired (401 "Invalid or expired token").
  const anon = (process.env.SUPABASE_ANON_KEY ?? '').trim();
  if (!anon) throw new Error('SUPABASE_ANON_KEY missing');
  const grant = await fetch(`${BASE}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: anon, 'content-type': 'application/json' }, body: JSON.stringify({ email: EMAIL, password: PASSWORD }) });
  const session = await grant.json() as Record<string, unknown>;
  console.log(`  supabase grant: ${grant.status}  keys: ${Object.keys(session).filter((k) => k !== 'user').join(',')}`);
  await page.goto(`${BASE}/favicon.png`, { waitUntil: 'domcontentloaded' });
  const encoded = `base64-${Buffer.from(JSON.stringify(session), 'utf8').toString('base64url')}`;
  const chunks = encoded.match(/.{1,3180}/g) ?? [];
  await ctx.addCookies(chunks.map((value, i) => ({ name: chunks.length === 1 ? 'sb-kortix-auth-token' : `sb-kortix-auth-token.${i}`, value, url: BASE, sameSite: 'Lax' as const })));

  // ONE navigation, straight to the session. Navigating away while the app's
  // first requests are in flight aborts them, and the app signs the user out
  // on an aborted /auth/v1/user ("Stale session detected") — measured here.
  const tOpen = now();
  await page.goto(`${BASE}/projects/${PROJ}/sessions/${sid}`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForRequest((rq) => rq.url().includes('/kortix/health'), { timeout: 90000 }).catch(() => null);
  ck('signed in (the app did not bounce to /auth)', !page.url().includes('/auth'), page.url());
  await page.waitForRequest((rq) => rq.url().includes('/global/event'), { timeout: 60000 }).catch(() => null);
  for (let i = 0; i < 12; i++) {
    await page.waitForTimeout(2000);
    const txt = await page.evaluate(() => document.body.innerText.replace(/\n+/g, ' | '));
    const m = txt.match(/Starting your session \| ([^|]+) \|/);
    console.log(`  t+${(i + 1) * 2}s loader: ${m ? m[1].trim() : 'gone'}`);
    if (!m) break;
  }
  console.log('  --- in-box requests since open, with offsets:');
  for (const x of inbox.filter((x) => x.t >= tOpen).slice(0, 40)) console.log(`    +${((x.t - tOpen) / 1000).toFixed(2)}s ${x.method} ${x.url.replace(BASE, '').replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, '<id>')} ${x.status ?? '…'}`);
  console.log('  --- every /v1/ request since open (path status):');
  for (const x of all.filter((x) => x.t >= tOpen)) console.log(`    ${x.method} ${new URL(x.url).pathname.replace(/\/v1\/projects\/[0-9a-f-]{36}/, '/v1/projects/<p>').replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, '<id>')}${new URL(x.url).search.slice(0, 30)} ${x.status ?? '…'}`);
  const boot = inbox.filter((x) => x.t >= tOpen);
  const sessionShaped = boot.filter((x) => x.url.includes(`/v1/p/${sid}/`)).length;
  const boxShaped = boot.filter((x) => /\/v1\/p\/sbx_/.test(x.url)).length;
  const s503 = boot.filter((x) => x.status === 503).length;
  const s404 = boot.filter((x) => x.status === 404).map((x) => new URL(x.url).pathname.split('/').slice(5).join('/'));
  console.log(`  in-box calls after open: ${boot.length}  session-shaped ${sessionShaped}  box-shaped ${boxShaped}  503s ${s503}  404s ${s404.length ? s404.join(',') : 0}`);
  ck('the deployed frontend addresses the SESSION, not the box', sessionShaped > 0 && boxShaped === 0, `session ${sessionShaped} box ${boxShaped}`);
  ck('no in-box call answered 503 on the shared runner', s503 === 0, `503s=${s503}`);
  const ev = boot.find((x) => x.url.includes('/global/event'));
  ck('the stream attached (200)', ev?.status === 200 || ev?.status === undefined, `status ${ev?.status}`);

  // Send a prompt from the composer and time the first assistant text.
  const word = `orchid${Math.floor(Math.random() * 1e5)}`;
  // A first visit can show the onboarding dialog (progressbar "Setup progress");
  // the lane skips it (tests/e2e/helpers/ui.ts dismissOnboarding).
  for (let i = 0; i < 12; i++) {
    const dlg = page.getByRole('dialog').filter({ has: page.getByRole('progressbar', { name: 'Setup progress' }) }).last();
    if (!(await dlg.isVisible().catch(() => false))) break;
    const skip = dlg.getByRole('button', { name: /^(Skip|Skip survey|Not now|Maybe later)/i }).last();
    if (await skip.isVisible().catch(() => false)) await skip.click({ timeout: 2000 }).catch(() => {});
    else { const later = dlg.getByRole('radio', { name: /^(Decide later|Keep what I have)/i }).first(); await later.click({ timeout: 2000 }).catch(() => {}); await dlg.getByRole('button', { name: /^(Continue|Next|Done|Finish)/i }).last().click({ timeout: 2000 }).catch(() => {}); }
    await page.waitForTimeout(400);
  }
  const dump = async (tag: string) => {
    await page.screenshot({ path: (process.env.SHOT ?? '/tmp/ui-e2e.png').replace('.png', `-${tag}.png`) }).catch(() => null);
    const info = await page.evaluate(() => ({
      url: location.href,
      inputs: Array.from(document.querySelectorAll('textarea,[contenteditable="true"],[role="textbox"],input:not([type=hidden])')).map((e) => `${e.tagName}#${(e as HTMLElement).id} .${(e as HTMLElement).className.toString().slice(0, 40)} vis=${(e as HTMLElement).offsetParent !== null}`).slice(0, 8),
      dialogs: Array.from(document.querySelectorAll('[role=dialog]')).map((d) => (d as HTMLElement).innerText.slice(0, 80)),
      sendButtons: document.querySelectorAll('[aria-label="Send message"]').length,
      bodyHead: document.body.innerText.slice(0, 300).replace(/\n+/g, ' | '),
    }));
    console.log(`  [${tag}]`, JSON.stringify(info));
  };
  // The composer: the editable element nearest the "Send message" button.
  let composer = page.locator('[contenteditable="true"], textarea, [role="textbox"]').last();
  try { await composer.waitFor({ timeout: 45000 }); } catch { await dump('no-composer'); throw new Error('composer not found'); }
  await composer.click();
  await page.keyboard.type(`Reply with exactly one word: ${word}`, { delay: 5 });
  const tSend = now();
  await page.keyboard.press('Enter');
  // EXACT text: an element whose text is only the word is the assistant's
  // answer; the user bubble reads the whole sentence and the sidebar title is
  // a capitalised version of it — neither matches exactly.
  const prompt = `Reply with exactly one word: ${word}`;
  const seen = page.getByText(word, { exact: true });
  let firstText = -1;
  try { await seen.first().waitFor({ timeout: 90000 }); firstText = now() - tSend; } catch { /* timed out */ }
  await page.waitForTimeout(3000);
  const wordCount = await page.getByText(word, { exact: true }).count();
  // Where each exact-prompt match lives: the conversation pane, or chrome
  // (the sidebar and header show the session TITLE, which is the first prompt).
  const chains = await page.getByText(prompt, { exact: true }).evaluateAll((els) => els.map((el) => {
    const parts: string[] = []; let n: Element | null = el;
    for (let i = 0; i < 9 && n; i++) { parts.push(`${n.tagName.toLowerCase()}${n.getAttribute('role') ? '[' + n.getAttribute('role') + ']' : ''}${n.getAttribute('data-testid') ? '#' + n.getAttribute('data-testid') : ''}`); n = n.parentElement; }
    return parts.join(' < ');
  }));
  for (const c of chains) console.log(`  [prompt-match] ${c}`);
  // A message bubble is never inside a link or a button; the session TITLE is
  // (the sidebar entry, the header tab), and the title is the first prompt.
  const inChrome = (c: string) => /(^|< )(nav|aside|header|a|button)\b/.test(c) || /\[navigation\]|\[banner\]/.test(c);
  const promptCount = chains.filter((c) => !inChrome(c)).length;
  console.log(`  prompt text: ${chains.length} matches, ${promptCount} in the conversation, ${chains.length - promptCount} in chrome (sidebar/header)`);
  console.log(`  send -> first assistant text on screen: ${firstText} ms`);
  ck('the answer rendered', firstText > 0, 'no answer within 90 s');
  ck('the answer is on screen exactly ONCE (no double)', wordCount === 1, `count=${wordCount}`);
  ck('the prompt is on screen exactly ONCE (no double)', promptCount === 1, `count=${promptCount}`);
  const during = inbox.filter((x) => x.t >= tSend);
  ck('no 503 during the turn', during.every((x) => x.status !== 503), JSON.stringify(during.filter((x) => x.status === 503).map((x) => new URL(x.url).pathname)).slice(0, 200));

  // A SECOND MESSAGE, and the order the conversation paints. Session 89848ff8
  // read user, user, assistant, assistant after its second message.
  const word2 = `tulip${Math.floor(Math.random() * 1e5)}`;
  const composer2 = page.locator('[contenteditable="true"], textarea, [role="textbox"]').last();
  await composer2.click();
  await page.keyboard.type(`Reply with exactly one word: ${word2}`, { delay: 5 });
  const tSend2 = now();
  await page.keyboard.press('Enter');
  let secondText = -1;
  try { await page.getByText(word2, { exact: true }).first().waitFor({ timeout: 90000 }); secondText = now() - tSend2; } catch { /* timed out */ }
  await page.waitForTimeout(2500);
  const logText = await page.locator('[role="log"]').first().innerText().catch(() => '');
  const order = [prompt, word, `Reply with exactly one word: ${word2}`, word2].map((needle) => logText.indexOf(needle));
  console.log(`  second send -> its answer on screen: ${secondText} ms   order indexes: ${JSON.stringify(order)}`);
  ck('the second answer rendered', secondText > 0, 'no second answer within 90 s');
  ck('the conversation reads user, assistant, user, assistant — in that order', order.every((x) => x >= 0) && order[0] < order[1] && order[1] < order[2] && order[2] < order[3], JSON.stringify(order));

  // Refresh: reconnect, transcript once.
  const tReload = now();
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 90000 });
  // The conversation's own render of the answer — exact text — not the
  // sidebar title that also carries the word.
  await page.getByText(word, { exact: true }).first().waitFor({ timeout: 60000 }).catch(() => null);
  const tTranscript = now() - tReload;
  await page.waitForTimeout(3000);
  const after = inbox.filter((x) => x.t >= tReload);
  await page.screenshot({ path: (process.env.SHOT ?? '/tmp/ui-e2e.png').replace('.png', '-after-reload.png') }).catch(() => null);
  const chainOf = (els: Element[]) => els.map((el) => { const parts: string[] = []; let n: Element | null = el; for (let i = 0; i < 9 && n; i++) { parts.push(`${n.tagName.toLowerCase()}${n.getAttribute('role') ? '[' + n.getAttribute('role') + ']' : ''}`); n = n.parentElement; } return parts.join(' < '); });
  const chains2 = await page.getByText(prompt, { exact: true }).evaluateAll(chainOf);
  // The answer after a reload: every element whose text contains the word,
  // classified — the sidebar title carries it too, the conversation must
  // carry it exactly once.
  const wordChains = await page.getByText(word, { exact: false }).evaluateAll((els) => els.map((el) => ({ text: (el.textContent ?? '').trim().slice(0, 60), chain: (() => { const parts: string[] = []; let n: Element | null = el; for (let i = 0; i < 9 && n; i++) { parts.push(`${n.tagName.toLowerCase()}${n.getAttribute('role') ? '[' + n.getAttribute('role') + ']' : ''}`); n = n.parentElement; } return parts.join(' < '); })() })));
  for (const w of wordChains) console.log(`  [answer-match after reload] "${w.text}"  ${w.chain}`);
  const answersInConversation = wordChains.filter((w) => !inChrome(w.chain) && !w.text.startsWith('Reply with exactly one word')).length;
  const body2 = { word: answersInConversation, prompt: chains2.filter((c) => !inChrome(c)).length };
  console.log(`  reload -> transcript visible: ${tTranscript} ms   in-box calls ${after.length}  503s ${after.filter((x) => x.status === 503).length}  404s ${after.filter((x) => x.status === 404).length}`);
  ck('after a refresh the page reconnects with no 503', after.length > 0 && after.every((x) => x.status !== 503), '');
  ck('and the transcript renders each message once', body2.word === 1 && body2.prompt === 1, `answer bubbles=${body2.word} prompt bubbles=${body2.prompt}`);
  const logText2 = await page.locator('[role="log"]').first().innerText().catch(() => '');
  const order2 = [prompt, word, `Reply with exactly one word: ${word2}`, word2].map((needle) => logText2.indexOf(needle));
  ck('and after the refresh the order still reads user, assistant, user, assistant', order2.every((x) => x >= 0) && order2[0] < order2[1] && order2[1] < order2[2] && order2[2] < order2[3], JSON.stringify(order2));
  await page.screenshot({ path: process.env.SHOT ?? '/tmp/ui-e2e.png', fullPage: false }).catch(() => null);
  // THE FILES PANEL AND THE FILE VIEWER. Ask for a file, open the panel, click
  // the file, read it in the viewer — the user's session showed "Failed to
  // load files / unknown route" and "This file couldn't be opened".
  const fileWord = `fern${Math.floor(Math.random() * 1e5)}`;
  const composer3 = page.locator('[contenteditable="true"], textarea, [role="textbox"]').last();
  await composer3.click();
  await page.keyboard.type(`Use your write tool to create the file /workspace/notes.txt containing exactly the text ${fileWord}-file-ok and then reply with the single word done`, { delay: 5 });
  await page.keyboard.press('Enter');
  await page.getByText('done', { exact: true }).first().waitFor({ timeout: 90000 }).catch(() => null);
  await page.waitForTimeout(1500);
  const fileCalls = [];
  page.on('response', (rs) => { const u = rs.url(); if (/\/8080\/(file|find)(\/|\?|$)/.test(u)) fileCalls.push({ url: u.replace(/^.*\/8080/, ''), status: rs.status() }); });
  const filesBtn = page.getByRole('button', { name: /^Files$/ }).first();
  const filesVisible = await filesBtn.isVisible().catch(() => false);
  if (filesVisible) await filesBtn.click(); else console.log('  (no Files button found in the header)');
  // INSIDE THE PANEL, NOT ANYWHERE ON THE PAGE. `getByText('notes.txt')`
  // matches the agent's own reply in the transcript, so this claim passed for
  // a session whose Files panel was empty — and then the click landed on a
  // paragraph and timed out after 30 s (2026-09-11). The panel is a dialog
  // labelled "Files" (features/session/action-panel/easy/detail-view.tsx) and
  // it lists ONE directory at a time, so a file the model chose to put in a
  // subdirectory is legitimately not here.
  const filesPanel = page.getByRole('dialog', { name: 'Files' });
  let listed = false;
  try { await filesPanel.getByText('notes.txt', { exact: true }).first().waitFor({ timeout: 20000 }); listed = true; } catch { /* not listed */ }
  ck('the Files panel lists the file the agent wrote (GET /file answered)', listed, JSON.stringify(fileCalls).slice(0, 300));
  let previewed = false;
  if (listed) {
    await filesPanel.getByText('notes.txt', { exact: true }).first().click({ timeout: 15000 }).catch(() => null);
    try { await page.getByText(`${fileWord}-file-ok`).first().waitFor({ timeout: 20000 }); previewed = true; } catch { /* no preview */ }
  }
  ck('clicking it opens the viewer with the file content (GET /file/content answered)', previewed, JSON.stringify(fileCalls).slice(0, 300));
  ck('no file route answered 404/503', fileCalls.length > 0 && fileCalls.every((c) => c.status !== 404 && c.status !== 503), JSON.stringify(fileCalls).slice(0, 300));

  // THE HTML PREVIEW. Opening an .html file frames it from the static file
  // server (port 3211 through the proxy). The user's session showed
  // "Starting preview server…" for its whole 30 s bound.
  const htmlWord = `lilac${Math.floor(Math.random() * 1e5)}`;
  const previewCalls = [];
  page.on('response', (rs) => { const u = rs.url(); if (/\/3211\//.test(u)) previewCalls.push({ url: u.replace(/^.*\/3211/, '').slice(0, 60), status: rs.status() }); });
  const composer4 = page.locator('[contenteditable="true"], textarea, [role="textbox"]').last();
  await composer4.click();
  await page.keyboard.type(`Use your write tool to create /workspace/page.html: a complete HTML page whose body holds one h1 element with the text ${htmlWord} and nothing else. Then reply with the single word finished`, { delay: 5 });
  await page.keyboard.press('Enter');
  let finishedSeen = true;
  await page.getByText('finished', { exact: true }).first().waitFor({ timeout: 90000 }).catch(() => { finishedSeen = false; });
  console.log(`  html write turn answered: ${finishedSeen}`);
  await page.waitForTimeout(1500);
  // The panel was already open: close and reopen it so the list is re-read
  // (whether the tree refreshes on its own is a separate check below).
  // THE TREE REFRESHES ON ITS OWN: the cell publishes `file.edited`, the
  // panel's list query is keyed on what that invalidates. No reopen.
  const listedLive = await filesPanel.getByText('page.html', { exact: true }).first().isVisible().catch(() => false);
  ck('the Files panel shows the new file without being reopened (file.edited → list refetch)', listedLive, '');
  let htmlListed = false;
  try { await filesPanel.getByText('page.html', { exact: true }).first().waitFor({ timeout: 20000 }); htmlListed = true; } catch { /* not listed */ }
  if (!htmlListed) {
    await page.screenshot({ path: `${process.env.SCRATCH ?? '/tmp'}/preview-step.png` }).catch(() => {});
    const panelText = await page.locator('aside, [role="complementary"], [data-panel]').allInnerTexts().catch(() => []);
    console.log(`  panel text: ${JSON.stringify(panelText).slice(0, 500)}`);
    const hits = await filesPanel.getByText(/page\.html/).count().catch(() => -1);
    console.log(`  elements containing page.html: ${hits}`);
  }
  let framed = false;
  if (htmlListed) {
    await filesPanel.getByText('page.html', { exact: true }).first().click({ timeout: 10000 }).catch(async () => { await filesPanel.getByText('page.html', { exact: true }).first().click({ force: true, timeout: 10000 }).catch(() => {}); });
    // The preview frame carries the file name as its title (HtmlPreview).
    const frames = () => page.locator('iframe').evaluateAll((els) => els.map((e) => ({ title: e.getAttribute('title'), src: (e.getAttribute('src') || '').replace(/^.*\/v1/, '/v1').slice(0, 90), sandbox: e.getAttribute('sandbox') })));
    await page.waitForTimeout(2000);
    console.log(`  iframes after click: ${JSON.stringify(await frames().catch(() => []))}`);
    try { await page.frameLocator('iframe[title="page.html"]').first().getByText(htmlWord).first().waitFor({ timeout: 45000 }); framed = true; } catch { /* no frame */ }
    if (!framed) { console.log(`  iframes after wait: ${JSON.stringify(await frames().catch(() => []))}`); await page.screenshot({ path: `${process.env.SCRATCH ?? '/tmp'}/preview-open.png` }).catch(() => {}); }
  }
  ck('an .html file opens in the viewer as a framed page (the preview server answered)', framed, JSON.stringify(previewCalls).slice(0, 400));
  ck('the preview health probe and /open answered 200', previewCalls.some((c) => /health/.test(c.url) && c.status === 200) && previewCalls.some((c) => /open/.test(c.url) && c.status === 200), JSON.stringify(previewCalls).slice(0, 400));
  // THE TERMINAL TAB. `/kortix/pty` — list, create, and one socket carrying
  // raw text. Every route was `unknown route` on a cell (2026-09-10), so the
  // tab could only say "connecting".
  const ptyCalls = [];
  page.on('response', (rs) => { if (/\/kortix\/pty/.test(rs.url())) ptyCalls.push({ url: rs.url().replace(/^.*\/8080/, ''), status: rs.status() }); });
  const termBtn = page.getByRole('button', { name: /^Terminal$/ }).first();
  const shellWord = `shell${Math.floor(Math.random() * 1e5)}`;
  let terminalText = '';
  if (await termBtn.isVisible().catch(() => false)) {
    await termBtn.click();
    await page.locator('.xterm-rows, .xterm-screen').first().waitFor({ timeout: 45000 }).catch(() => {});
    await page.waitForTimeout(3000);
    await page.locator('.xterm-helper-textarea, .xterm').first().click({ timeout: 10000 }).catch(() => {});
    await page.keyboard.type(`echo ${shellWord}`, { delay: 20 });
    await page.keyboard.press('Enter');
    await page.waitForTimeout(4000);
    terminalText = await page.locator('.xterm-rows').first().innerText().catch(() => '');
  } else {
    console.log('  (no Terminal button in the header)');
  }
  ck('the Terminal tab opens a shell in the cell', /just-bash|\$/.test(terminalText), `${JSON.stringify(terminalText.slice(0, 200))} calls=${JSON.stringify(ptyCalls).slice(0, 200)}`);
  ck('and a command typed into it runs there', terminalText.includes(shellWord) && terminalText.split(shellWord).length > 2, JSON.stringify(terminalText.slice(-200)));
  ck('the pty routes answered (no 404/503)', ptyCalls.length > 0 && ptyCalls.every((c) => c.status !== 404 && c.status !== 503), JSON.stringify(ptyCalls).slice(0, 300));

  await browser.close();
  console.log(`\n  real browser: ${pass} passed, ${fail} failed   session=${sid}`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error('  CRASH', e?.message ?? e); process.exit(2); });
