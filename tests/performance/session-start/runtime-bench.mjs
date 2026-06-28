// Raw Daytona runtime provisioning benchmark: compares create->running (and
// create->exec-ready) across sandbox classes/regions. Isolates the RUNTIME's
// provisioning speed (our daemon boots identically once the box is up, so the
// only runtime-dependent delta is create->reachable).
//
// Runtimes (configurable): container@us vs linux-vm@us-west-2.
// Env: DAYTONA_API_KEY, DAYTONA_SERVER_URL, N (default 1), IMAGE (ubuntu:22.04).
import { Daytona, SandboxClass } from '@daytonaio/sdk';

const API_KEY = process.env.DAYTONA_API_KEY;
const API_URL = process.env.DAYTONA_SERVER_URL || 'https://app.daytona.io/api';
const N = Number(process.env.N || 1);
const IMAGE = process.env.IMAGE || 'ubuntu:22.04';
const now = () => performance.now();
const ms = (t) => Math.round(now() - t);
const sleep = (x) => new Promise((r) => setTimeout(r, x));

const RUNTIMES = [
  { key: 'container@us', target: 'us', sandboxClass: SandboxClass.CONTAINER, snapshot: 'bench-container-ubuntu2204' },
  { key: 'linux-vm@us-west-2', target: 'us-west-2', sandboxClass: SandboxClass.LINUX_VM, snapshot: 'bench-linuxvm-ubuntu2204' },
];

async function ensureSnapshot(daytona, name, sandboxClass) {
  try {
    const existing = await daytona.snapshot.get(name);
    if (existing && String(existing.state).toLowerCase().includes('active')) {
      return { reused: true, ms: 0 };
    }
  } catch { /* not found → create */ }
  const t = now();
  await daytona.snapshot.create(
    { name, image: IMAGE, sandboxClass },
    { onLogs: () => {} },
  );
  return { reused: false, ms: ms(t) };
}

async function benchRuntime(rt) {
  const out = { key: rt.key, snapshotMs: null, samples: [], errors: [] };
  let daytona;
  try {
    daytona = new Daytona({ apiKey: API_KEY, apiUrl: API_URL, target: rt.target });
  } catch (e) { out.errors.push(`client: ${e.message}`); return out; }

  try {
    const snap = await ensureSnapshot(daytona, rt.snapshot, rt.sandboxClass);
    out.snapshotMs = snap.ms;
    out.snapshotReused = snap.reused;
    console.log(`[${rt.key}] snapshot ${snap.reused ? 'reused' : `built in ${snap.ms}ms`}`);
  } catch (e) {
    out.errors.push(`snapshot: ${e.message}`);
    console.log(`[${rt.key}] snapshot FAILED: ${e.message}`);
    return out;
  }

  for (let i = 0; i < N; i++) {
    let sandbox = null;
    const sample = { createMs: null, execMs: null, error: null };
    try {
      const tc = now();
      sandbox = await daytona.create({ snapshot: rt.snapshot }, { timeout: 120 });
      sample.createMs = ms(tc); // create() resolves when the box is running
      // create->exec-ready: run a trivial command
      try {
        const te = now();
        await sandbox.process.executeCommand('echo ok');
        sample.execMs = ms(te);
      } catch (e) { sample.execErr = e.message?.slice(0, 90); }
      console.log(`[${rt.key}] #${i + 1} create->running=${sample.createMs}ms exec=${sample.execMs ?? 'n/a'}ms${sample.execErr ? ` (execErr: ${sample.execErr})` : ''}`);
    } catch (e) {
      sample.error = e.message?.slice(0, 160);
      console.log(`[${rt.key}] #${i + 1} create FAILED: ${sample.error}`);
    } finally {
      if (sandbox) { try { await daytona.delete(sandbox, 30); } catch (e) { out.errors.push(`delete: ${e.message?.slice(0,80)}`); } }
    }
    out.samples.push(sample);
    if (i < N - 1) await sleep(1500);
  }
  return out;
}

function stats(xs) {
  const a = xs.filter((x) => x != null).sort((p, q) => p - q);
  if (!a.length) return { n: 0 };
  const med = a.length % 2 ? a[(a.length - 1) / 2] : Math.round((a[a.length / 2 - 1] + a[a.length / 2]) / 2);
  return { n: a.length, min: a[0], med, max: a[a.length - 1] };
}

(async () => {
  if (!API_KEY) throw new Error('DAYTONA_API_KEY missing');
  console.log(`# Daytona runtime benchmark  image=${IMAGE} N=${N}\n`);
  const results = [];
  for (const rt of RUNTIMES) {
    console.log(`\n===== ${rt.key} (target=${rt.target}, class=${rt.sandboxClass}) =====`);
    results.push(await benchRuntime(rt));
  }
  console.log(`\n\n=========== SUMMARY (create -> running, ms) ===========`);
  console.log('runtime'.padEnd(22) + 'n'.padStart(3) + 'min'.padStart(8) + 'median'.padStart(8) + 'max'.padStart(8) + '   snapshot   exec(med)');
  for (const r of results) {
    const c = stats(r.samples.map((s) => s.createMs));
    const e = stats(r.samples.map((s) => s.execMs));
    const snap = r.snapshotReused ? 'reused' : (r.snapshotMs != null ? `${r.snapshotMs}ms` : 'FAIL');
    console.log(
      r.key.padEnd(22) + String(c.n).padStart(3) + String(c.min ?? '-').padStart(8) + String(c.med ?? '-').padStart(8) + String(c.max ?? '-').padStart(8) +
      `   ${snap.padEnd(9)} ${e.med ?? '-'}`,
    );
    if (r.errors.length) console.log(`   errors: ${r.errors.slice(0, 3).join(' | ')}`);
  }
})().catch((e) => { console.error('BENCH FAILED:', e); process.exit(1); });
