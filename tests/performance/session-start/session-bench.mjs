// End-to-end session-start latency benchmark (real provisioning, real opencode).
//
// Drives the EXACT client flow the dashboard uses and times every step a user
// waits on, lining up three independent timelines so the total is attributable:
//   1. client-observed start-poll stages   (provisioning -> starting -> ready)
//   2. host provisionTimeline (from DB)     (row+tokens -> image -> provider-create)
//   3. proxied daemon/opencode health + plain CRUD (read/list/patch/delete)
//
// Steps measured per session:
//   POST /sessions (201) -> poll /start until ready -> GET /sandbox active
//   -> /p/:ext/8000/kortix/health -> /global/health -> first file list
//   -> READ / LIST / PATCH / DELETE
//
// Run via ./run.sh (injects the local Supabase + DB secrets). Env knobs:
//   N, POLL_MS, READY_TIMEOUT_MS, PROVIDER, PROJECT_ID, BENCH_EMAIL, BENCH_UID
//
// NOTE: each iteration provisions (and deletes) a REAL cloud sandbox. Keep N small.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const API = process.env.API_BASE || 'http://localhost:8008/v1';
const SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:54321';
const ANON = must('SUPABASE_ANON_KEY');
const SVC = must('SUPABASE_SERVICE_ROLE_KEY');
const DBURL = must('DATABASE_URL');
const EMAIL = must('BENCH_EMAIL');
const PW = process.env.BENCH_PW || 'BenchPass123!';
const BENCH_UID = must('BENCH_UID');
const PROJECT_ID = must('PROJECT_ID');
const N = Number(process.env.N || 3);
const PROVIDER = process.env.PROVIDER || undefined; // undefined => server default
const POLL_MS = Number(process.env.POLL_MS || 400);
const READY_TIMEOUT_MS = Number(process.env.READY_TIMEOUT_MS || 120_000);

function must(k) {
  const v = process.env[k];
  if (!v) throw new Error(`missing env ${k}`);
  return v;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now();

async function timed(fn) {
  const t0 = now();
  let value, error;
  try { value = await fn(); } catch (e) { error = e; }
  return { ms: Math.round(now() - t0), value, error };
}

async function apiFetch(token, method, path, body, timeoutMs = 15_000) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  let json = null;
  const text = await res.text();
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, json };
}

function psql(sql) {
  return execFileSync('psql', [DBURL, '-tAc', sql], { encoding: 'utf8' }).trim();
}

async function resetPasswordAndSignIn() {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${BENCH_UID}`, {
    method: 'PUT',
    headers: { apikey: SVC, Authorization: `Bearer ${SVC}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: PW, email_confirm: true }),
  });
  if (!r.ok) throw new Error(`admin pw reset failed: ${r.status} ${await r.text()}`);
  const s = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PW }),
  });
  const sj = await s.json();
  if (!sj.access_token) throw new Error(`sign-in failed: ${JSON.stringify(sj)}`);
  return sj.access_token;
}

async function runIteration(token, i) {
  const sessionId = randomUUID();
  const events = [];
  const t0 = now();
  const at = () => +(((now() - t0) / 1000)).toFixed(2);
  const mark = (label) => events.push({ at: at(), label });

  const create = await timed(() =>
    apiFetch(token, 'POST', `/projects/${PROJECT_ID}/sessions`, {
      session_id: sessionId,
      ...(PROVIDER ? { provider: PROVIDER } : {}),
    }),
  );
  const createStatus = create.value?.status;
  mark(`CREATE -> ${createStatus} (${create.ms}ms)`);
  if (createStatus !== 201 && createStatus !== 202) {
    return { i, sessionId, failed: true, reason: `create ${createStatus}`, events };
  }
  const createBody = create.value.json;

  let lastStage = null, lastSandboxStatus = null, externalId = null;
  let tLeaveProvisioning = null, tActive = null, tReady = null;
  let provider = createBody?.sandbox_provider || null;
  let pollCalls = 0, terminal = null;
  const deadline = now() + READY_TIMEOUT_MS;
  while (now() < deadline) {
    const poll = await timed(() =>
      apiFetch(token, 'POST', `/projects/${PROJECT_ID}/sessions/${sessionId}/start?wait_ms=0`, undefined, 12_000),
    );
    pollCalls++;
    const p = poll.value?.json || {};
    const stage = p.stage;
    const sb = p.sandbox || null;
    if (sb?.provider) provider = sb.provider;
    if (stage && stage !== lastStage) {
      mark(`start.stage=${stage}${p.reason ? ` (${p.reason})` : ''}`);
      if (lastStage === 'provisioning' && tLeaveProvisioning === null) tLeaveProvisioning = at();
      lastStage = stage;
    }
    if (sb && sb.status !== lastSandboxStatus) {
      mark(`sandbox.status=${sb.status}${sb.external_id ? ' +external_id' : ''}`);
      if (sb.status === 'active' && tActive === null) tActive = at();
      lastSandboxStatus = sb.status;
    }
    if (sb?.external_id && !externalId) externalId = sb.external_id;
    if (stage === 'ready') { tReady = at(); break; }
    if (stage === 'failed' || stage === 'stopped') { terminal = stage; mark(`TERMINAL ${stage}`); break; }
    await sleep(POLL_MS);
  }

  if (!externalId) {
    const sbx = await apiFetch(token, 'GET', `/projects/${PROJECT_ID}/sessions/${sessionId}/sandbox`);
    externalId = sbx.json?.external_id || null;
    if (sbx.json?.provider) provider = sbx.json.provider;
  }

  let daemonHealth = null, opencodeHealth = null, fileList = null;
  if (externalId && tReady !== null) {
    daemonHealth = await timed(() => apiFetch(token, 'GET', `/p/${externalId}/8000/kortix/health`, undefined, 12_000));
    mark(`daemon /kortix/health -> ${daemonHealth.value?.status} (${daemonHealth.ms}ms)`);
    opencodeHealth = await timed(() => apiFetch(token, 'GET', `/p/${externalId}/8000/global/health`, undefined, 12_000));
    mark(`opencode /global/health -> ${opencodeHealth.value?.status} (${opencodeHealth.ms}ms)`);
    fileList = await timed(() => apiFetch(token, 'GET', `/p/${externalId}/8000/file?path=${encodeURIComponent('.')}`, undefined, 15_000));
    mark(`first file list -> ${fileList.value?.status} (${fileList.ms}ms)`);
  }

  const read = await timed(() => apiFetch(token, 'GET', `/projects/${PROJECT_ID}/sessions/${sessionId}`));
  const list = await timed(() => apiFetch(token, 'GET', `/projects/${PROJECT_ID}/sessions`));
  const patch = await timed(() => apiFetch(token, 'PATCH', `/projects/${PROJECT_ID}/sessions/${sessionId}`, { name: `bench-${i}-renamed` }));
  const del = await timed(() => apiFetch(token, 'DELETE', `/projects/${PROJECT_ID}/sessions/${sessionId}`));
  mark(`READ ${read.value?.status} (${read.ms}ms) | LIST ${list.value?.status} (${list.ms}ms) | PATCH ${patch.value?.status} (${patch.ms}ms) | DELETE ${del.value?.status} (${del.ms}ms)`);

  let hostTimeline = null;
  try {
    const raw = psql(`select coalesce((metadata->'provisionTimeline')::text,'') from kortix.session_sandboxes where sandbox_id='${sessionId}'::uuid limit 1;`);
    if (raw) hostTimeline = JSON.parse(raw);
  } catch (e) { hostTimeline = { error: String(e) }; }

  return {
    i, sessionId, externalId, provider, terminal,
    create_ms: create.ms, tLeaveProvisioning, tActive, tReady, pollCalls,
    daemon_health_ms: daemonHealth?.ms ?? null, opencode_health_ms: opencodeHealth?.ms ?? null, file_list_ms: fileList?.ms ?? null,
    read_ms: read.ms, list_ms: list.ms, patch_ms: patch.ms, delete_ms: del.ms,
    hostTimeline, events,
  };
}

function median(xs) {
  const a = xs.filter((x) => x != null).sort((p, q) => p - q);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : Math.round((a[m - 1] + a[m]) / 2);
}

(async () => {
  console.log(`# Session-start E2E benchmark`);
  console.log(`api=${API} project=${PROJECT_ID} provider=${PROVIDER || '(server default)'} N=${N} poll=${POLL_MS}ms\n`);
  const token = await resetPasswordAndSignIn();
  console.log(`auth OK\n`);

  const results = [];
  for (let i = 1; i <= N; i++) {
    console.log(`\n===================== ITERATION ${i}/${N} =====================`);
    const r = await runIteration(token, i);
    results.push(r);
    for (const e of r.events) console.log(`  ${String(e.at).padStart(6)}s  ${e.label}`);
    if (r.hostTimeline?.marks) {
      console.log(`  HOST provisionTimeline: total=${r.hostTimeline.totalMs}ms  ` +
        r.hostTimeline.marks.map((x) => `${x.label}=+${x.deltaMs}ms(@${x.atMs})`).join('  '));
    }
    console.log(`  provider=${r.provider}  ready@${r.tReady}s  active@${r.tActive}s`);
    if (i < N) await sleep(2000);
  }

  console.log(`\n\n=========================== SUMMARY (medians over ${N}) ===========================`);
  const ok = results.filter((r) => r.tReady != null);
  const providerCreate = (r) => r.hostTimeline?.marks?.find((m) => m.label.startsWith('provider-create'))?.deltaMs ?? null;
  const rows = [
    ['CREATE 201 (sync API, ms)', results.map((r) => r.create_ms)],
    ['-> ready (client total, ms)', ok.map((r) => Math.round(r.tReady * 1000))],
    ['  sandbox active (ms)', ok.map((r) => (r.tActive != null ? Math.round(r.tActive * 1000) : null))],
    ['HOST total row->active (ms)', results.map((r) => r.hostTimeline?.totalMs ?? null)],
    ['  host provider-create (ms)', results.map(providerCreate)],
    ['daemon health (ms)', results.map((r) => r.daemon_health_ms)],
    ['opencode health (ms)', results.map((r) => r.opencode_health_ms)],
    ['first file list (ms)', results.map((r) => r.file_list_ms)],
    ['READ (ms)', results.map((r) => r.read_ms)],
    ['LIST (ms)', results.map((r) => r.list_ms)],
    ['PATCH (ms)', results.map((r) => r.patch_ms)],
    ['DELETE (ms)', results.map((r) => r.delete_ms)],
  ];
  console.log('step'.padEnd(30) + 'median'.padStart(10) + '   raw');
  for (const [label, xs] of rows) {
    console.log(label.padEnd(30) + String(median(xs) ?? '-').padStart(10) + `   [${xs.join(', ')}]`);
  }
  console.log(`\nproviders: ${results.map((r) => r.provider).join(', ')}`);
})().catch((e) => { console.error('BENCH FAILED:', e); process.exit(1); });
