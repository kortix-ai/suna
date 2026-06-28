// Daytona container create->running spike repro. Creates N container sandboxes
// from a tiny ubuntu:22.04 snapshot in target=us via the SDK, timing how long
// daytona.create() takes to resolve (i.e. create -> "running"). Captures sandbox
// id + ISO timestamp + org for each so the Daytona team can grep their logs, and
// flags spikes (>8s). Deletes every sandbox.
import { Daytona, SandboxClass } from '@daytonaio/sdk';
import { createRequire } from 'node:module';

const API_KEY = process.env.DAYTONA_API_KEY;
const API_URL = process.env.DAYTONA_SERVER_URL || 'https://app.daytona.io/api';
const N = Number(process.env.N || 25);
const TARGET = process.env.TARGET || 'us';
const SNAPSHOT = process.env.SNAPSHOT || 'bench-container-ubuntu2204';
const SPIKE_MS = Number(process.env.SPIKE_MS || 8000);
const sleep = (x) => new Promise((r) => setTimeout(r, x));
const sdkVersion = (() => { try { return createRequire(import.meta.url)('@daytonaio/sdk/package.json').version; } catch { return '?'; } })();

(async () => {
  const d = new Daytona({ apiKey: API_KEY, apiUrl: API_URL, target: TARGET });
  // ensure snapshot exists (container/ubuntu:22.04)
  try { await d.snapshot.get(SNAPSHOT); }
  catch { await d.snapshot.create({ name: SNAPSHOT, image: 'ubuntu:22.04', sandboxClass: SandboxClass.CONTAINER }, { onLogs: () => {} }); }

  console.log(`# Daytona container create->running spike repro`);
  console.log(`sdk=@daytonaio/sdk@${sdkVersion} target=${TARGET} class=container snapshot=${SNAPSHOT} image=ubuntu:22.04 N=${N}\n`);
  const rows = [];
  let orgId = null;
  for (let i = 0; i < N; i++) {
    const startedAt = new Date().toISOString();
    const t0 = Date.now();
    let id = null, ms = null, err = null, state = null;
    try {
      const sb = await d.create({ snapshot: SNAPSHOT }, { timeout: 120 });
      ms = Date.now() - t0;
      id = sb.id;
      state = sb.state ?? null;
      orgId = orgId || sb.organizationId || sb.orgId || null;
    } catch (e) { err = e.message?.slice(0, 160); ms = Date.now() - t0; }
    const spike = ms != null && ms >= SPIKE_MS;
    rows.push({ i: i + 1, startedAt, id, ms, state, err, spike });
    console.log(`#${String(i + 1).padStart(2)} ${startedAt} create->running=${ms != null ? ms + 'ms' : 'FAIL'}${spike ? '  <<< SPIKE' : ''}  id=${id ?? '-'}${err ? `  err=${err}` : ''}`);
    if (id) { try { await d.delete(await d.get(id), 30); } catch {} }
    await sleep(1200);
  }
  const ok = rows.filter((r) => r.ms != null && !r.err);
  const times = ok.map((r) => r.ms).sort((a, b) => a - b);
  const med = times.length ? times[Math.floor(times.length / 2)] : null;
  const spikes = rows.filter((r) => r.spike);
  console.log(`\n=== SUMMARY ===`);
  console.log(`org=${orgId} sdk=${sdkVersion} target=${TARGET} class=container`);
  console.log(`n=${ok.length} min=${times[0]}ms median=${med}ms max=${times[times.length - 1]}ms`);
  console.log(`spikes(>=${SPIKE_MS}ms): ${spikes.length}/${rows.length} (${Math.round((spikes.length / rows.length) * 100)}%)`);
  for (const s of spikes) console.log(`  SPIKE ${s.startedAt}  ${s.ms}ms  sandbox=${s.id}`);
})().catch((e) => { console.error('REPRO FAILED:', e); process.exit(1); });
