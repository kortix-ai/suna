// Deep boot probe: create a session, then read opencode's OWN log + the baked vs
// runtime dep versions through the daemon /file proxy (which allows /opt, /home,
// /tmp, /workspace). Use this to attribute the spawn->session-created window:
// the gap between opencode "loading <workspace>/.kortix/opencode/opencode.jsonc"
// and "init" is the plugin load/install phase. Comparing the baked vs workspace
// @opencode-ai/plugin version reveals whether opencode re-installed it over the
// network (version mismatch => baked deps must pin the OPENCODE binary version).
// Run via ./run.sh oclog-probe.
import { randomUUID } from 'node:crypto';
const API = process.env.API_BASE || 'http://localhost:8008/v1';
const SUPABASE_URL = process.env.SUPABASE_URL, ANON = process.env.SUPABASE_ANON_KEY, SVC = process.env.SUPABASE_SERVICE_ROLE_KEY;
const EMAIL = process.env.BENCH_EMAIL, PW = process.env.BENCH_PW || 'BenchPass123!', UID = process.env.BENCH_UID, PROJECT_ID = process.env.PROJECT_ID;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function token() {
  await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${UID}`, { method: 'PUT', headers: { apikey: SVC, Authorization: `Bearer ${SVC}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PW, email_confirm: true }) });
  return (await (await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: EMAIL, password: PW }) })).json()).access_token;
}
async function api(t, m, p, b) {
  const r = await fetch(`${API}${p}`, { method: m, headers: { Authorization: `Bearer ${t}`, ...(b ? { 'Content-Type': 'application/json' } : {}) }, body: b ? JSON.stringify(b) : undefined, signal: AbortSignal.timeout(20000) });
  const txt = await r.text(); let j = null; try { j = txt ? JSON.parse(txt) : null; } catch { j = txt; } return { status: r.status, j };
}
const praw = async (t, ext, path) => {
  const r = await fetch(`${API}/p/${ext}/8000/file/raw?path=${encodeURIComponent(path)}`, { headers: { Authorization: `Bearer ${t}` }, signal: AbortSignal.timeout(20000) });
  return { status: r.status, text: await r.text() };
};
(async () => {
  const t = await token(); const sid = randomUUID(); const t0 = Date.now();
  await api(t, 'POST', `/projects/${PROJECT_ID}/sessions`, { session_id: sid });
  let ext = null;
  for (;;) {
    if (Date.now() - t0 > 120000) { console.log('timeout'); break; }
    const p = await api(t, 'POST', `/projects/${PROJECT_ID}/sessions/${sid}/start?wait_ms=0`);
    ext = p.j?.sandbox?.external_id || ext;
    if (p.j?.stage === 'ready') { console.log(`ready @ ${((Date.now() - t0) / 1000).toFixed(1)}s ext=${ext}`); break; }
    if (['failed', 'stopped'].includes(p.j?.stage)) { console.log('terminal', p.j?.stage); break; }
    await sleep(300);
  }
  if (ext) {
    const log = await praw(t, ext, '/opt/kortix/home/.local/share/opencode/log/opencode.log');
    console.log(`\n=== opencode.log (status ${log.status}) ===\n` + log.text.slice(-7000));
    for (const p of [
      '/opt/kortix/opencode-config-deps/node_modules/@opencode-ai/plugin/package.json',
      '/workspace/.kortix/opencode/node_modules/@opencode-ai/plugin/package.json',
    ]) {
      const r = await praw(t, ext, p);
      const v = (() => { try { return JSON.parse(r.text).version; } catch { return r.text.slice(0, 120); } })();
      console.log(`\n${p} -> version=${v} (status ${r.status})`);
    }
  }
  await api(t, 'DELETE', `/projects/${PROJECT_ID}/sessions/${sid}`);
  console.log('\ndeleted');
})().catch((e) => { console.error(e); process.exit(1); });
