// Single-session boot probe: create a session, poll /start to ready, then dump
// the daemon's in-container boot_timeline (from /kortix/health) so the
// active->ready window is attributed to its in-sandbox steps:
//   static-web -> git-identity -> repo-materialized -> config-deps
//   -> opencode-spawned -> proxy-up -> opencode-session-created -> opencode-ready
//
// The spawn->session-created delta is the opencode cold-start + project-init cost
// (and, when the baked deps are wrong, a network plugin install). Then deletes.
// Run via ./run.sh boot-probe. Env: PROBE_DEADLINE_MS (default 90000).
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
(async () => {
  const t = await token(); const sid = randomUUID(); const t0 = Date.now();
  const DEADLINE = Number(process.env.PROBE_DEADLINE_MS || 90000);
  await api(t, 'POST', `/projects/${PROJECT_ID}/sessions`, { session_id: sid });
  let ext = null;
  for (;;) {
    if (Date.now() - t0 > DEADLINE) { console.log('timeout'); break; }
    const p = await api(t, 'POST', `/projects/${PROJECT_ID}/sessions/${sid}/start?wait_ms=0`);
    ext = p.j?.sandbox?.external_id || ext;
    if (p.j?.stage === 'ready') { console.log(`ready @ ${((Date.now() - t0) / 1000).toFixed(1)}s`); break; }
    if (['failed', 'stopped'].includes(p.j?.stage)) { console.log('terminal', p.j?.stage); break; }
    await sleep(300);
  }
  if (ext) {
    const h = await api(t, 'GET', `/p/${ext}/8000/kortix/health`);
    console.log('\n=== /kortix/health (daemon boot timeline) ===');
    console.log(JSON.stringify(h.j?.boot_timeline ?? h.j, null, 2));
  }
  await api(t, 'DELETE', `/projects/${PROJECT_ID}/sessions/${sid}`);
  console.log('\ndeleted');
})().catch((e) => { console.error(e); process.exit(1); });
