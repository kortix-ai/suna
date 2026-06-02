/**
 * Isolated benchmark of `daytona.create()` from a NAMED snapshot — the
 * create→active long pole, with NO git/opencode/Kortix boot in the path.
 *
 * It splits the SDK's create() into its two real phases so we can attribute
 * the seconds and hand Daytona an apples-to-apples report vs their ~90ms claim:
 *   1. createSandbox()      — the control-plane create API call
 *   2. wait → 'started'     — runner scheduling + container start from snapshot
 *
 *   cd apps/api && KORTIX_URL=<anything> \
 *     bun --env-file=.env run scripts/bench-daytona-create.ts
 *
 * Env: ITERS (default 6), SNAPSHOT (override; else newest ready kortix-* snap).
 * Creates + DELETES N throwaway sandboxes. No Kortix DB rows are written.
 */
import { getDaytona, listDaytonaSnapshots } from '../src/shared/daytona';

const ITERS = Number(process.env.ITERS || 6);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pct = (arr: number[], p: number) => {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const fmt = (a: number[]) =>
  `min=${Math.min(...a)}  p50=${pct(a, 50)}  p90=${pct(a, 90)}  max=${Math.max(...a)}  mean=${Math.round(a.reduce((x, y) => x + y, 0) / a.length)}`;

async function main() {
  const daytona: any = getDaytona();
  const api = daytona.sandboxApi;
  const target = daytona.target;

  let snap = process.env.SNAPSHOT || '';
  if (!snap) {
    const snaps = await listDaytonaSnapshots();
    const ready = snaps
      .filter((s) => /^kortix-/.test(s.name) && /active|ready/i.test(s.state))
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    if (!ready.length) throw new Error('no active kortix-* snapshot found; set SNAPSHOT=<name>');
    snap = ready[0].name;
    console.log(`[bench] auto-picked newest ready snapshot (of ${snaps.length} total)`);
  }
  console.log(`\n[bench] daytona.create from NAMED snapshot  "${snap}"\n        target=${target}  iters=${ITERS}\n`);

  // Raw control-plane RTT from this machine, to separate network distance from
  // provisioning time (our bench runs from a laptop; prod API may be closer).
  const base = (process.env.DAYTONA_SERVER_URL || 'https://app.daytona.io/api').replace(/\/+$/, '');
  const rtts: number[] = [];
  for (let i = 0; i < 5; i++) {
    const t = Date.now();
    await fetch(`${base}/sandbox?limit=1`, { headers: { Authorization: `Bearer ${process.env.DAYTONA_API_KEY}` } }).catch(() => {});
    rtts.push(Date.now() - t);
  }
  console.log(`[bench] raw Daytona API RTT (authed GET): ${rtts.map((x) => x + 'ms').join(' ')}  median=${pct(rtts, 50)}ms\n`);

  const env = { KORTIX_API_URL: 'https://bench.invalid/v1', KORTIX_TOKEN: 'bench-dummy' };
  const createMs: number[] = [];
  const waitMs: number[] = [];
  const totalMs: number[] = [];
  const ids: string[] = [];

  for (let i = 1; i <= ITERS; i++) {
    const t0 = Date.now();
    const resp = await api.createSandbox(
      { snapshot: snap, env, target, autoStopInterval: 15, autoArchiveInterval: 30, public: false },
      undefined,
      { timeout: 60_000 },
    );
    const tCreate = Date.now() - t0;
    let inst = resp.data;
    const id = inst.id;
    ids.push(id);
    const initState = String(inst.state);

    const tw = Date.now();
    while (String(inst.state).toLowerCase() !== 'started') {
      const st = String(inst.state).toLowerCase();
      if (st === 'error' || st === 'build_failed') throw new Error(`sandbox ${id} -> ${st}: ${inst.errorReason}`);
      if (Date.now() - tw > 90_000) { console.log(`  iter ${i}: TIMEOUT (last state=${st})`); break; }
      await sleep(100);
      inst = (await api.getSandbox(id)).data;
    }
    const tWait = Date.now() - tw;
    createMs.push(tCreate);
    waitMs.push(tWait);
    totalMs.push(tCreate + tWait);
    console.log(
      `  iter ${i}: createSandbox=${tCreate}ms  initState=${initState}  wait→started=${tWait}ms  ` +
        `TOTAL=${((tCreate + tWait) / 1000).toFixed(2)}s  runner=${inst.target} ${inst.cpu}cpu/${inst.memory}gb`,
    );
  }

  console.log(`\n[bench] cleanup: deleting ${ids.length} sandboxes…`);
  for (const id of ids) {
    try { await (await daytona.get(id)).delete(); } catch (e) { /* best-effort */ }
  }

  console.log(`\n[bench] ─── RESULTS (named-snapshot create, n=${ITERS}) ───`);
  console.log(`  1. createSandbox (control-plane call):  ${fmt(createMs)}  ms`);
  console.log(`  2. wait → 'started' (container start):  ${fmt(waitMs)}  ms`);
  console.log(`  =  TOTAL create→started:                ${fmt(totalMs)}  ms`);
  console.log('');
}

main().then(() => process.exit(0)).catch((e) => { console.error(`\n[bench] FAILED: ${e?.message || e}\n`); process.exit(1); });
