/**
 * COLD TIME-TO-FIRST-TOKEN — the only latency number the split can move.
 *
 * Total task time is dominated by the model thinking, which is identical on
 * both architectures and drowns the thing being decided. This measures the
 * part that is actually different: from "create the sandbox" to "the agent
 * starts speaking".
 *
 *   t0    daytona.create() is called
 *   stop  the first token of the assistant's answer arrives
 *
 * Both arms, both cold, same model, same provider, same region.
 *
 * METHOD. Each arm is timed in two sequential segments:
 *   create  measured on the benchmark host's clock (create() call to return)
 *   serve   measured INSIDE the sandbox by a script that waits for readiness,
 *           sends the prompt, and stops at the first streamed token
 * The exec dispatch that starts that script sits between them and is charged
 * to BOTH arms identically, so the comparison is fair even though the absolute
 * carries a small constant.
 */
import { Daytona, Image } from '@daytonaio/sdk';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SPIKE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = resolve(SPIKE, '..', '..');
const secret = (k: string) =>
  execFileSync('dotenvx', ['get', k, '-f', '.env'], { cwd: join(REPO, 'apps', 'api'), encoding: 'utf8' }).trim();
const sh = async (b: any, c: string, t = 420) =>
  String((await b.process.executeCommand(c, undefined, undefined, t)).result ?? '');
const arg = (f: string, d: string) => process.argv.find((a) => a.startsWith(`${f}=`))?.split('=')[1] ?? d;

const RUNS = Number(arg('--runs', '3'));
const MODEL = arg('--model', 'anthropic/claude-sonnet-4.5');
const PROMPT = arg('--prompt', 'Say the single word: ready');
const W_SNAP = 'kortix-worker-ttft-v1';
const E_SNAP = 'kortix-env-ttft-v1';

const ms = (n: number | null) => (n == null ? '     n/a' : `${String(Math.round(n)).padStart(6)} ms`);
const med = (xs: number[]) => {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : Number.NaN;
};

const daytona = new Daytona({
  apiKey: secret('DAYTONA_API_KEY'), apiUrl: secret('DAYTONA_SERVER_URL'), target: secret('DAYTONA_TARGET'),
});
const OR = secret('OPENROUTER_API_KEY');

import { readFileSync } from 'node:fs';

/**
 * The measurers are real files, uploaded verbatim — not template literals.
 *
 * Building them as template strings put three layers of escaping between the
 * source and the running script (TS template, shell heredoc, JS string). A
 * single `\n` survived as a real newline and produced a SyntaxError that
 * silently read as "the old architecture produced no measurement". Files have
 * no escaping layers at all.
 */
const measurer = (name: string) => readFileSync(join(SPIKE, 'bench', 'measure', name), 'utf8');

/** Upload a measurer and run it, returning the parsed line it prints. */
async function measure(box: any, name: string, envVars: Record<string, string>, label: string) {
  const b64 = Buffer.from(measurer(name), 'utf8').toString('base64');
  await sh(box, `echo '${b64}' | base64 -d > /tmp/m.js`);
  const exports = Object.entries(envVars).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ');
  const out = await sh(box, `${exports} node /tmp/m.js 2>&1`, 420);
  const m = /MEASURE=(\{.*\})/.exec(out);
  if (!m) { console.log(`  [${label}] no MEASURE — raw:\n${out.slice(0, 500)}`); return {}; }
  return JSON.parse(m[1]) as { ready?: number; first?: number; err?: string };
}

async function ensure(name: string, dockerfile: string, entry: string[]) {
  const s = await daytona.snapshot.get(name).catch(() => null);
  if (s && String((s as any).state ?? '').toLowerCase().includes('active')) return;
  console.log(`  building ${name}… (one-off, excluded from every number)`);
  await daytona.snapshot.create(
    { name, image: Image.fromDockerfile(join(SPIKE, dockerfile)), entrypoint: entry, resources: { cpu: 2, memory: 6, disk: 20 } },
    { timeout: 900, onLogs: () => {} },
  );
}

async function main() {
  console.log('\n' + '='.repeat(74));
  console.log('  COLD TIME-TO-FIRST-TOKEN — Daytona ' + secret('DAYTONA_TARGET'));
  console.log('='.repeat(74));
  console.log(`  prompt "${PROMPT}"  ·  model ${MODEL}  ·  runs ${RUNS}`);
  console.log('  t0 = create the sandbox   stop = first token of the answer\n');

  await ensure(W_SNAP, 'Dockerfile', ['node', '/opt/kortix/worker.mjs']);
  await ensure(E_SNAP, 'Dockerfile.environment', ['node', '/opt/kortix/environment.mjs']);

  const snapRes: any = await daytona.snapshot.list();
  const snaps: any[] = Array.isArray(snapRes) ? snapRes : (snapRes.items ?? []);
  const current = snaps
    .filter((s) => String(s.name).startsWith('kortix-default-') && String(s.state).toLowerCase().includes('active'))
    .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))[0];
  if (!current) throw new Error('no active kortix-default-* snapshot');
  console.log(`  today's image: ${current.name} (${Number(current.size ?? 0).toFixed(1)} GB)\n`);

  const alive: any[] = [];
  const OLD: any[] = [], NEW: any[] = [];

  try {
    const envBox = await daytona.create({ snapshot: E_SNAP, envVars: { PORT: '8100', ENV_ROOT: '/env-root' }, autoStopInterval: 0 }, { timeout: 300 });
    alive.push(envBox);
    const envLink = await envBox.getPreviewLink(8100);

    for (let i = 1; i <= RUNS; i++) {
      console.log(`run ${i}/${RUNS}`);

      // ---- today: one box, opencode ------------------------------------
      let t = Date.now();
      const ob = await daytona.create({ snapshot: current.name, envVars: { OPENROUTER_API_KEY: OR }, autoStopInterval: 15 }, { timeout: 300 });
      const oCreate = Date.now() - t;
      alive.push(ob);
      const oOut = await measure(ob, 'opencode.js', { KX_PROMPT: PROMPT, KX_MODEL: MODEL }, 'TODAY');
      const o = { create: oCreate, ready: oCreate + (oOut.ready ?? NaN), first: oCreate + (oOut.first ?? NaN), err: oOut.err };
      OLD.push(o);
      console.log(`  TODAY   create ${ms(o.create)}  ready ${ms(o.ready)}  FIRST TOKEN ${ms(o.first)}${o.err ? '  ' + o.err : ''}`);
      await ob.delete().catch(() => {}); alive.splice(alive.indexOf(ob), 1);

      // ---- worker: cold, environment deliberately off the critical path --
      // No tool is called for this prompt, so the environment is never touched
      // before the first token. That is the design: compute is provisioned
      // lazily, on the first tool call. Including its provision here would be
      // measuring something the user never waits for. It is created once,
      // outside the loop, for the same reason.
      t = Date.now();
      const wb = await daytona.create({
        snapshot: W_SNAP,
        envVars: {
          PORT: '8080', KORTIX_MODEL_MODE: 'real', KORTIX_PROVIDER: 'openrouter', KORTIX_MODEL: MODEL,
          KORTIX_API_KEY: OR, KORTIX_ENV_URL: envLink.url, KORTIX_ENV_CWD: '/workspace', KORTIX_ENV_TRANSPORT: 'ws',
          KORTIX_SYSTEM_PROMPT: 'You are a Kortix agent. Answer briefly.',
          ...(envLink.token ? { KORTIX_ENV_HEADERS: JSON.stringify({ 'x-daytona-preview-token': envLink.token }) } : {}),
        },
        autoStopInterval: 15,
      }, { timeout: 300 });
      const wCreate = Date.now() - t;
      alive.push(wb);
      const wOut = await measure(wb, 'worker.js', { KX_PROMPT: PROMPT }, 'WORKER');
      const w = { create: wCreate, ready: wCreate + (wOut.ready ?? NaN), first: wCreate + (wOut.first ?? NaN) };
      NEW.push(w);
      console.log(`  WORKER  create ${ms(w.create)}  ready ${ms(w.ready)}  FIRST TOKEN ${ms(w.first)}\n`);
      await wb.delete().catch(() => {}); alive.splice(alive.indexOf(wb), 1);
    }

    console.log('='.repeat(74));
    console.log('  MEDIANS                   create        ready    FIRST TOKEN');
    console.log('='.repeat(74));
    console.log(`  today — one 6.2 GB box  ${ms(med(OLD.map((x) => x.create)))}  ${ms(med(OLD.map((x) => x.ready)))}  ${ms(med(OLD.map((x) => x.first)))}`);
    console.log(`  worker + environment    ${ms(med(NEW.map((x) => x.create)))}  ${ms(med(NEW.map((x) => x.ready)))}  ${ms(med(NEW.map((x) => x.first)))}`);
    console.log('='.repeat(74));
    const o = med(OLD.map((x) => x.first)), n = med(NEW.map((x) => x.first));
    if (Number.isFinite(o) && Number.isFinite(n)) {
      console.log(`\n  cold time-to-first-token: ${(n / 1000).toFixed(2)}s vs ${(o / 1000).toFixed(2)}s  =  ${(o / n).toFixed(2)}x  (${((o - n) / 1000).toFixed(2)}s sooner)`);
    }
    console.log(`\n${JSON.stringify({ prompt: PROMPT, model: MODEL, old: OLD, worker: NEW }, null, 2)}`);
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

main().catch((e) => { console.error('\nTTFT BENCH FAILED:', e?.message ?? e); process.exit(1); });
