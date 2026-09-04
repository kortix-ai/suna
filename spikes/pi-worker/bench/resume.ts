/**
 * The measurement the huddle actually argued about: resume from ARCHIVED.
 *
 * Daytona's own words for archive:
 *
 *   "the entire filesystem state is moved to cost-effective object storage...
 *    starting an archived sandbox takes more time, DEPENDING ON ITS SIZE."
 *
 * That is the claim Marko and Kubet went back and forth on — whether a 6 GB
 * box costs more to bring back than a small one, and by how much. Nothing in
 * the create-from-snapshot benchmark touches it, because create never restores
 * a filesystem from object storage.
 *
 * Both arms take the identical journey:
 *   create -> started -> stop -> stopped -> archive -> archived -> start
 * and the number is that last transition: archived -> able to serve.
 *
 * Everything created is deleted, including on failure.
 */
import { Daytona, Image } from '@daytonaio/sdk';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SPIKE = resolve(HERE, '..');
const REPO = resolve(SPIKE, '..', '..');

const argv = process.argv.slice(2);
const has = (f: string) => argv.includes(f);
const val = (f: string, d: string) => argv.find((a) => a.startsWith(`${f}=`))?.split('=').slice(1).join('=') ?? d;
const RUNS = Number(val('--runs', '2'));
const MODEL = val('--model', 'anthropic/claude-sonnet-4.5');
const SNAPSHOT = 'kortix-worker-resume-v1';

const secret = (k: string) =>
  execFileSync('dotenvx', ['get', k, '-f', '.env'], { cwd: join(REPO, 'apps', 'api'), encoding: 'utf8' }).trim();
const ms = (n: number | null | undefined) => (n == null ? '    n/a' : `${String(Math.round(n)).padStart(7)} ms`);
const med = (xs: number[]) => {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : Number.NaN;
};
const sh = async (b: any, c: string, t = 120) =>
  String((await b.process.executeCommand(c, undefined, undefined, t)).result ?? '');
const GET = (u: string) => `(command -v curl >/dev/null 2>&1 && curl -sf --max-time 5 '${u}') || wget -qO- '${u}'`;
const POST = (u: string, b: string) =>
  `(command -v curl >/dev/null 2>&1 && curl -sf --max-time 180 -H 'content-type: application/json' -d '${b}' '${u}') ` +
  `|| wget -qO- --header='content-type: application/json' --post-data='${b}' '${u}'`;

/** Poll the control plane until the sandbox reaches one of `states`. */
async function waitState(box: any, states: string[], label: string, timeoutMs = 900_000): Promise<number> {
  const t0 = Date.now();
  for (;;) {
    await box.refreshData().catch(() => {});
    const st = String((box as any).state ?? '').toLowerCase();
    if (states.includes(st)) return Date.now() - t0;
    if (st === 'error' || st === 'build_failed') throw new Error(`${label}: sandbox entered ${st}`);
    if (Date.now() - t0 > timeoutMs) throw new Error(`${label}: timed out in state ${st}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

interface Arm {
  name: string;
  archiveMs: number;
  startCallMs: number;
  toStartedMs: number;
  toServingMs: number | null;
  answer?: string;
}

async function main() {
  const daytona = new Daytona({
    apiKey: secret('DAYTONA_API_KEY'),
    apiUrl: secret('DAYTONA_SERVER_URL'),
    target: secret('DAYTONA_TARGET'),
  });
  const orKey = secret('OPENROUTER_API_KEY');

  const snapRes: any = await daytona.snapshot.list();
  const snaps: any[] = Array.isArray(snapRes) ? snapRes : (snapRes.items ?? []);
  const current = snaps
    .filter((s) => String(s.name).startsWith('kortix-default-') && String(s.state).toLowerCase().includes('active'))
    .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))[0];
  if (!current) throw new Error('no active kortix-default-* snapshot on this account');

  console.log('\n' + '='.repeat(74));
  console.log('  Resume from ARCHIVED — the case the huddle argued about');
  console.log('='.repeat(74));
  console.log(`  NEW      ${SNAPSHOT}  (~140 MB image)`);
  console.log(`  CURRENT  ${current.name}  (${Number(current.size ?? 0).toFixed(1)} GB image)`);
  console.log(`  journey  create -> stop -> archive -> START (this is the measurement)`);
  console.log(`  runs     ${RUNS}\n`);

  const existing = await daytona.snapshot.get(SNAPSHOT).catch(() => null);
  if (!existing || !String((existing as any).state ?? '').toLowerCase().includes('active')) {
    console.log('building worker snapshot (one-off, excluded from every number)…');
    await daytona.snapshot.create(
      {
        name: SNAPSHOT,
        image: Image.fromDockerfile(join(SPIKE, 'Dockerfile')),
        entrypoint: ['node', '/opt/kortix/worker.mjs'],
        resources: { cpu: 2, memory: 6, disk: 20 },
      },
      { timeout: 900, onLogs: () => {} },
    );
    console.log('  built\n');
  }

  const alive: any[] = [];
  const results: Arm[] = [];

  const cycle = async (kind: 'new' | 'current'): Promise<Arm> => {
    const isNew = kind === 'new';
    const box = await daytona.create(
      {
        snapshot: isNew ? SNAPSHOT : current.name,
        envVars: isNew
          ? {
              PORT: '8080',
              KORTIX_MODEL_MODE: 'real',
              KORTIX_PROVIDER: 'openrouter',
              KORTIX_MODEL: MODEL,
              KORTIX_API_KEY: orKey,
              KORTIX_SYSTEM_PROMPT: 'You are a Kortix agent. Answer briefly.',
            }
          : { KORTIX_BENCH: '1' },
        autoStopInterval: 0,
        public: false,
      },
      { timeout: 300 },
    );
    alive.push(box);

    // Let it fully come up once, so the archived filesystem is a REAL warmed
    // box and not a half-initialised one.
    const readyProbe = isNew
      ? `for i in $(seq 1 900); do ${GET('http://127.0.0.1:8080/health')} >/dev/null 2>&1 && break; sleep 0.1; done`
      : `for i in $(seq 1 1800); do H=$(${GET('http://127.0.0.1:8000/kortix/health')} 2>/dev/null); case "$H" in *'"runtimeReady":true'*) break;; esac; sleep 0.1; done`;
    await sh(box, readyProbe, 420);

    await box.stop();
    await waitState(box, ['stopped'], 'stop');

    const tArc = Date.now();
    await box.archive();
    const archiveMs = await waitState(box, ['archived'], 'archive') + (Date.now() - tArc - (Date.now() - tArc));

    // ---- the measurement -------------------------------------------------
    const t0 = Date.now();
    await box.start(600);
    const startCallMs = Date.now() - t0;
    const toStartedMs = startCallMs + (await waitState(box, ['started'], 'start'));

    let toServingMs: number | null = null;
    let answer: string | undefined;
    if (isNew) {
      await sh(box, `for i in $(seq 1 900); do ${GET('http://127.0.0.1:8080/health')} >/dev/null 2>&1 && break; sleep 0.1; done`, 300);
      toServingMs = Date.now() - t0;
      const raw = await sh(box, POST('http://127.0.0.1:8080/say', JSON.stringify({ text: 'One short sentence: what did you just resume from?' })), 240);
      try { answer = JSON.parse(raw.trim().split('\n').pop() || '{}').answer; } catch { /* ignore */ }
    } else {
      const p = await sh(
        box,
        `for i in $(seq 1 3000); do H=$(${GET('http://127.0.0.1:8000/kortix/health')} 2>/dev/null); case "$H" in *'"runtimeReady":true'*) echo "READY=$i"; break;; esac; sleep 0.1; done`,
        600,
      );
      toServingMs = /READY=/.test(p) ? Date.now() - t0 : null;
    }

    await box.delete().catch(() => {});
    alive.splice(alive.indexOf(box), 1);
    return { name: isNew ? 'NEW' : 'CURRENT', archiveMs, startCallMs, toStartedMs, toServingMs, answer };
  };

  try {
    for (let i = 1; i <= RUNS; i++) {
      console.log(`run ${i}/${RUNS}`);
      for (const kind of ['new', 'current'] as const) {
        const r = await cycle(kind);
        results.push(r);
        console.log(
          `  ${r.name.padEnd(8)} archive ${ms(r.archiveMs)}   start() ${ms(r.startCallMs)}   ` +
            `-> started ${ms(r.toStartedMs)}   -> SERVING ${ms(r.toServingMs)}`,
        );
        if (r.answer) console.log(`           > ${r.answer.trim().slice(0, 140)}`);
      }
      console.log('');
    }

    const pick = (n: string, f: (a: Arm) => number | null) => med(results.filter((r) => r.name === n).map((r) => f(r) as number));
    console.log('='.repeat(74));
    console.log('  MEDIANS — archived -> able to serve');
    console.log('='.repeat(74));
    console.log(`  NEW      start() ${ms(pick('NEW', (r) => r.startCallMs))}   started ${ms(pick('NEW', (r) => r.toStartedMs))}   serving ${ms(pick('NEW', (r) => r.toServingMs))}`);
    console.log(`  CURRENT  start() ${ms(pick('CURRENT', (r) => r.startCallMs))}   started ${ms(pick('CURRENT', (r) => r.toStartedMs))}   serving ${ms(pick('CURRENT', (r) => r.toServingMs))}`);
    console.log('='.repeat(74));
    const a = pick('NEW', (r) => r.toServingMs), b = pick('CURRENT', (r) => r.toServingMs);
    if (Number.isFinite(a) && Number.isFinite(b)) {
      console.log(`\n  resume from object storage: ${(b / 1000).toFixed(1)}s vs ${(a / 1000).toFixed(1)}s  =  ${(b / a).toFixed(1)}x`);
    }
    console.log(`\n${JSON.stringify(results, null, 2)}`);
  } finally {
    console.log(`\ncleanup: ${alive.length} sandbox(es)`);
    for (const s of alive) await s.delete().then(() => console.log(`  deleted ${s.id}`)).catch(() => {});
    if (has('--delete-snapshots')) {
      const snap = await daytona.snapshot.get(SNAPSHOT).catch(() => null);
      if (snap) await daytona.snapshot.delete(snap).then(() => console.log(`  deleted snapshot ${SNAPSHOT}`)).catch(() => {});
    }
  }
}

main().catch((e) => { console.error('\nRESUME BENCH FAILED:', e?.message ?? e); process.exit(1); });
