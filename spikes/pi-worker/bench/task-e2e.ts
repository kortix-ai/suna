/**
 * The comparison that actually answers "is this better": ONE TASK, both
 * architectures, from cold, on real Daytona sandboxes.
 *
 * Everything before this measured pieces — boot, resume, per-call RPC. This
 * measures what a user experiences: they ask for something that needs real
 * compute, and they wait until it is done.
 *
 *   TASK    create a file in the workspace, read it back, report its contents
 *   MODEL   the same model, through the same provider (OpenRouter), both arms
 *   CLOCK   t0 = "create the sandbox", stop = "the answer is in hand"
 *
 * FAIRNESS, STATED UP FRONT. Today's approach is ONE box that is both harness
 * and compute. The new approach is TWO. Counting only the worker would flatter
 * it, so the new arm is measured twice:
 *
 *   cold  worker and environment both provisioned from nothing at t0. The
 *         honest worst case, and what a first-ever session pays.
 *   warm  environment already running (the pooled steady state the plan
 *         designs for), worker cold.
 *
 * The old arm gets the easier deal throughout: its box needs no second
 * provision, and it is given its provider key at create time so nothing waits
 * on configuration.
 */
import { Daytona, Image } from '@daytonaio/sdk';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SPIKE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = resolve(SPIKE, '..', '..');
const secret = (k: string) =>
  execFileSync('dotenvx', ['get', k, '-f', '.env'], { cwd: join(REPO, 'apps', 'api'), encoding: 'utf8' }).trim();
const sh = async (b: any, c: string, t = 300) =>
  String((await b.process.executeCommand(c, undefined, undefined, t)).result ?? '');

const arg = (f: string, d: string) => process.argv.find((a) => a.startsWith(`${f}=`))?.split('=')[1] ?? d;
const RUNS = Number(arg('--runs', '3'));
const MODEL = arg('--model', 'anthropic/claude-sonnet-4.5');
const TASK = arg(
  '--task',
  'Create /workspace/hello.txt containing exactly the word kortix, then read it back and tell me what it says.',
);
const W_SNAP = 'kortix-worker-task-v1';
const E_SNAP = 'kortix-env-task-v1';

const ms = (n: number | null) => (n == null ? '     n/a' : `${String(Math.round(n)).padStart(6)} ms`);
const med = (xs: number[]) => {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : Number.NaN;
};

const daytona = new Daytona({
  apiKey: secret('DAYTONA_API_KEY'), apiUrl: secret('DAYTONA_SERVER_URL'), target: secret('DAYTONA_TARGET'),
});
const OR = secret('OPENROUTER_API_KEY');

async function ensure(name: string, dockerfile: string, entry: string[]) {
  const s = await daytona.snapshot.get(name).catch(() => null);
  if (s && String((s as any).state ?? '').toLowerCase().includes('active')) return;
  console.log(`  building ${name}… (one-off, excluded from every number)`);
  await daytona.snapshot.create(
    { name, image: Image.fromDockerfile(join(SPIKE, dockerfile)), entrypoint: entry, resources: { cpu: 2, memory: 6, disk: 20 } },
    { timeout: 900, onLogs: () => {} },
  );
}

/** Today's approach: one fat box, opencode driven over its own HTTP API. */
async function oldArm(snapshot: string, alive: any[]) {
  const t0 = Date.now();
  const box = await daytona.create(
    { snapshot, envVars: { OPENROUTER_API_KEY: OR }, autoStopInterval: 15 }, { timeout: 300 },
  );
  alive.push(box);
  const created = Date.now() - t0;

  await sh(box, `for i in $(seq 1 1800); do curl -sf http://127.0.0.1:8000/kortix/health | grep -q '"runtimeReady":true' && break; sleep 0.1; done`, 420);
  const ready = Date.now() - t0;

  const body = JSON.stringify({
    model: { providerID: 'openrouter', modelID: MODEL },
    parts: [{ type: 'text', text: TASK }],
  }).replace(/'/g, `'\\''`);
  const out = await sh(
    box,
    `S=$(curl -sf --max-time 30 -X POST http://127.0.0.1:4096/session -H 'content-type: application/json' -d '{}' | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])') ; ` +
      `echo "SID=$S" ; ` +
      `curl -sf --max-time 300 -X POST "http://127.0.0.1:4096/session/$S/message" -H 'content-type: application/json' -d '${body}'`,
    420,
  );
  const answered = Date.now() - t0;

  let answer = '';
  try {
    const jsonStart = out.indexOf('{', out.indexOf('SID='));
    const msg = JSON.parse(out.slice(jsonStart));
    const parts = msg?.parts ?? msg?.info?.parts ?? [];
    answer = parts.filter((p: any) => p.type === 'text').map((p: any) => p.text).join('').trim();
  } catch { answer = out.slice(-200).trim(); }

  await box.delete().catch(() => {});
  alive.splice(alive.indexOf(box), 1);
  return { created, ready, answered, answer };
}

/** The split: a small worker, plus an environment it RPCs into. */
async function newArm(envBox: any | null, alive: any[]) {
  const t0 = Date.now();

  // Cold variant provisions the environment concurrently with the worker —
  // the speculative pre-warm the plan calls for, which is what a real lazy
  // start would approximate since the first model round trip overlaps it.
  const envPromise = envBox
    ? Promise.resolve(envBox)
    : daytona.create({ snapshot: E_SNAP, envVars: { PORT: '8100', ENV_ROOT: '/env-root' }, autoStopInterval: 15 }, { timeout: 300 })
        .then((b) => { alive.push(b); return b; });

  const env = await envPromise;
  const link = await env.getPreviewLink(8100);

  const w = await daytona.create(
    {
      snapshot: W_SNAP,
      envVars: {
        PORT: '8080',
        KORTIX_MODEL_MODE: 'real',
        KORTIX_PROVIDER: 'openrouter',
        KORTIX_MODEL: MODEL,
        KORTIX_API_KEY: OR,
        KORTIX_ENV_URL: link.url,
        KORTIX_ENV_CWD: '/workspace',
        KORTIX_ENV_TRANSPORT: 'ws',
        KORTIX_SYSTEM_PROMPT: 'You are a Kortix agent. Answer briefly.',
        ...(link.token ? { KORTIX_ENV_HEADERS: JSON.stringify({ 'x-daytona-preview-token': link.token }) } : {}),
      },
      autoStopInterval: 15,
    },
    { timeout: 300 },
  );
  alive.push(w);
  const created = Date.now() - t0;

  await sh(w, `for i in $(seq 1 900); do wget -qO- http://127.0.0.1:8080/health >/dev/null 2>&1 && break; sleep 0.1; done`, 300);
  const ready = Date.now() - t0;

  const say = JSON.stringify({ text: TASK }).replace(/'/g, `'\\''`);
  const raw = await sh(w, `wget -qO- --header='content-type: application/json' --post-data='${say}' http://127.0.0.1:8080/say`, 420);
  const answered = Date.now() - t0;
  let answer = '';
  try { answer = String(JSON.parse(raw.trim().split('\n').pop() || '{}').answer ?? '').trim(); } catch { answer = raw.slice(-200); }

  await w.delete().catch(() => {});
  alive.splice(alive.indexOf(w), 1);
  return { created, ready, answered, answer };
}

async function main() {
  console.log('\n' + '='.repeat(76));
  console.log('  ONE TASK, BOTH ARCHITECTURES, FROM COLD — Daytona ' + secret('DAYTONA_TARGET'));
  console.log('='.repeat(76));
  console.log(`  task   ${TASK}`);
  console.log(`  model  ${MODEL} via OpenRouter (identical on both arms)`);
  console.log(`  runs   ${RUNS}\n`);

  await ensure(W_SNAP, 'Dockerfile', ['node', '/opt/kortix/worker.mjs']);
  await ensure(E_SNAP, 'Dockerfile.environment', ['node', '/opt/kortix/environment.mjs']);

  const snapRes: any = await daytona.snapshot.list();
  const snaps: any[] = Array.isArray(snapRes) ? snapRes : (snapRes.items ?? []);
  const current = snaps
    .filter((s) => String(s.name).startsWith('kortix-default-') && String(s.state).toLowerCase().includes('active'))
    .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))[0];
  if (!current) throw new Error('no active kortix-default-* snapshot found');
  console.log(`  today's image: ${current.name} (${Number(current.size ?? 0).toFixed(1)} GB)\n`);

  const alive: any[] = [];
  const OLD: any[] = [], NEW_COLD: any[] = [], NEW_WARM: any[] = [];

  try {
    // One long-lived environment for the warm variant.
    const warmEnv = await daytona.create({ snapshot: E_SNAP, envVars: { PORT: '8100', ENV_ROOT: '/env-root' }, autoStopInterval: 0 }, { timeout: 300 });
    alive.push(warmEnv);

    for (let i = 1; i <= RUNS; i++) {
      console.log(`run ${i}/${RUNS}`);

      const o = await oldArm(current.name, alive);
      OLD.push(o);
      console.log(`  TODAY      create ${ms(o.created)}  ready ${ms(o.ready)}  ANSWERED ${ms(o.answered)}`);
      console.log(`             > ${o.answer.slice(0, 120)}`);

      const nc = await newArm(null, alive);
      NEW_COLD.push(nc);
      console.log(`  WORKER c   create ${ms(nc.created)}  ready ${ms(nc.ready)}  ANSWERED ${ms(nc.answered)}`);
      console.log(`             > ${nc.answer.slice(0, 120)}`);

      const nw = await newArm(warmEnv, alive);
      NEW_WARM.push(nw);
      console.log(`  WORKER w   create ${ms(nw.created)}  ready ${ms(nw.ready)}  ANSWERED ${ms(nw.answered)}`);
      console.log(`             > ${nw.answer.slice(0, 120)}\n`);
    }

    const row = (label: string, xs: any[]) =>
      `  ${label.padEnd(26)} ${ms(med(xs.map((x) => x.created)))}  ${ms(med(xs.map((x) => x.ready)))}  ${ms(med(xs.map((x) => x.answered)))}`;
    console.log('='.repeat(76));
    console.log('  MEDIANS                      create        ready      ANSWERED');
    console.log('='.repeat(76));
    console.log(row("today — one 6.2 GB box", OLD));
    console.log(row('worker + cold environment', NEW_COLD));
    console.log(row('worker + warm environment', NEW_WARM));
    console.log('='.repeat(76));

    const o = med(OLD.map((x) => x.answered));
    const c = med(NEW_COLD.map((x) => x.answered));
    const w = med(NEW_WARM.map((x) => x.answered));
    const fmt = (a: number, b: number) =>
      a < b ? `${((b - a) / 1000).toFixed(1)}s faster` : `${((a - b) / 1000).toFixed(1)}s slower`;
    console.log(`\n  worker + cold env vs today: ${fmt(c, o)}`);
    console.log(`  worker + warm env vs today: ${fmt(w, o)}`);
    console.log(`\n${JSON.stringify({ task: TASK, model: MODEL, old: OLD, newCold: NEW_COLD, newWarm: NEW_WARM }, null, 2)}`);
  } finally {
    console.log(`\ncleanup: ${alive.length} sandbox(es)`);
    for (const s of alive) await s.delete().then(() => console.log(`  deleted ${s.id}`)).catch(() => {});
    if (process.argv.includes('--delete-snapshots')) {
      for (const n of [W_SNAP, E_SNAP]) {
        const snap = await daytona.snapshot.get(n).catch(() => null);
        if (snap) await daytona.snapshot.delete(snap).then(() => console.log(`  deleted snapshot ${n}`)).catch(() => {});
      }
    }
  }
}

main().catch((e) => { console.error('\nTASK E2E FAILED:', e?.message ?? e); process.exit(1); });
