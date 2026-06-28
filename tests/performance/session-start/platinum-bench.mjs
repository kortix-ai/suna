// Platinum (our microVM platform) create->running benchmark. Plain REST, Bearer
// key — mirrors apps/api/src/platform/providers/platinum.ts create(): POST
// /v1/sandboxes?wait_for_state=running&wait_timeout_ms=60000 with a kortix-default
// template (which bakes our daemon), measure, then DELETE. Env: PLATINUM_API_URL,
// PLATINUM_API_KEY, N (default 1), PLATINUM_TEMPLATE (else first kortix-default).
const URL_ = process.env.PLATINUM_API_URL;
const KEY = process.env.PLATINUM_API_KEY;
const N = Number(process.env.N || 1);
const now = () => performance.now();
const ms = (t) => Math.round(now() - t);
const sleep = (x) => new Promise((r) => setTimeout(r, x));
const H = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
const j = async (p, o = {}) => {
  const r = await fetch(URL_ + p, { ...o, headers: { ...H, ...(o.headers || {}) }, signal: AbortSignal.timeout(o.timeoutMs ?? 70000) });
  const text = await r.text();
  let body = null; try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: r.status, body };
};

(async () => {
  if (!KEY) throw new Error('PLATINUM_API_KEY missing');
  let template = process.env.PLATINUM_TEMPLATE;
  if (!template) {
    const t = await j('/v1/templates');
    const tpls = Array.isArray(t.body) ? t.body : [];
    const def = tpls.find((x) => /kortix-default/.test(x.name) && String(x.state).toLowerCase() === 'ready') || tpls[0];
    template = def?.id;
    console.log(`template: ${template} (${def?.name}, region=${def?.region}, ${def?.defaultCpu}cpu/${def?.defaultRamMb}mb)`);
  }
  if (!template) throw new Error('no platinum template available');

  const samples = [];
  for (let i = 0; i < N; i++) {
    let id = null;
    const s = { runningMs: null, error: null };
    try {
      const tc = now();
      const res = await j('/v1/sandboxes?wait_for_state=running&wait_timeout_ms=60000', {
        method: 'POST',
        body: JSON.stringify({ template, cpu: 2, ram_mb: 6144, disk_gb: 20, auto_stop_minutes: 5, type: 'ephemeral' }),
        timeoutMs: 70000,
      });
      if (res.status >= 200 && res.status < 300) {
        s.runningMs = ms(tc);
        id = res.body?.id || res.body?.sandboxId;
      } else {
        s.error = `HTTP ${res.status}: ${JSON.stringify(res.body).slice(0, 160)}`;
      }
      console.log(`#${i + 1} create->running=${s.runningMs ?? 'FAIL'}ms ${s.error ? `(${s.error})` : `id=${id}`}`);
    } catch (e) {
      s.error = `${e.name}: ${e.message?.slice(0, 120)}`;
      console.log(`#${i + 1} ERR ${s.error}`);
    } finally {
      if (id) { await j(`/v1/sandboxes/${id}`, { method: 'DELETE' }).catch(() => null); }
    }
    samples.push(s);
    if (i < N - 1) await sleep(1500);
  }
  const xs = samples.map((s) => s.runningMs).filter((x) => x != null).sort((a, b) => a - b);
  const med = xs.length ? (xs.length % 2 ? xs[(xs.length - 1) / 2] : Math.round((xs[xs.length / 2 - 1] + xs[xs.length / 2]) / 2)) : null;
  console.log(`\n=== Platinum create->running (ms): n=${xs.length} min=${xs[0] ?? '-'} median=${med ?? '-'} max=${xs[xs.length - 1] ?? '-'} ===`);
  const errs = samples.filter((s) => s.error);
  if (errs.length) console.log(`errors (${errs.length}): ${errs.slice(0, 3).map((e) => e.error).join(' | ')}`);
})().catch((e) => { console.error('BENCH FAILED:', e); process.exit(1); });
