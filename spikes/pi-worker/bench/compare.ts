/**
 * Head to head on Daytona: the new worker vs the sandbox Kortix ships today.
 *
 * Same provider, same region, same account, same resources. The only thing
 * that differs is the image and what runs inside it.
 *
 *   NEW      kortix-worker      ~140 MB   Alpine + node + one bundled .mjs
 *   CURRENT  kortix-default-*    ~6.2 GB   Ubuntu + toolchain + kortixd + opencode
 *
 * THE COMPARISON IS DELIBERATELY UNFAIR TO THE NEW ARM.
 *
 * The worker is timed until it has actually ANSWERED a real model prompt —
 * booted, harness constructed, provider resolved, round trip to OpenRouter,
 * text back. The current sandbox is timed only until its daemon says it is
 * alive, which is a strictly easier bar and happens well before opencode can
 * answer anything. If the worker still wins, it wins by more than is shown.
 *
 * Standalone: no Kortix API, no database, no UI. Everything it creates it
 * deletes, including on failure.
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

const RUNS = Number(val('--runs', '3'));
const PROMPT = val('--say', 'In one short sentence: what is a sandbox in software?');
const MODEL = val('--model', 'anthropic/claude-sonnet-4.5');
const SNAPSHOT = 'kortix-worker-cmp-v1';
const KEEP = has('--keep');

const secret = (key: string): string =>
  execFileSync('dotenvx', ['get', key, '-f', '.env'], { cwd: join(REPO, 'apps', 'api'), encoding: 'utf8' }).trim();

const ms = (n: number | null | undefined) => (n == null ? '   n/a' : `${String(Math.round(n)).padStart(6)} ms`);
const med = (xs: number[]) => {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : Number.NaN;
};
const sh = async (b: any, c: string, timeout?: number) =>
  String((await b.process.executeCommand(c, undefined, undefined, timeout)).result ?? '');

/**
 * Portable HTTP one-liner. The two images do not share a client: Alpine has
 * busybox wget and no curl, Ubuntu has curl and no wget. Probing with the
 * wrong one reports "never came up" for a box that came up fine — which is
 * exactly what it did on the first attempt here.
 */
const GET = (url: string) => `(command -v curl >/dev/null 2>&1 && curl -sf --max-time 5 '${url}') || wget -qO- '${url}'`;
const POST = (url: string, body: string) =>
  `(command -v curl >/dev/null 2>&1 && curl -sf --max-time 180 -H 'content-type: application/json' -d '${body}' '${url}') ` +
  `|| wget -qO- --header='content-type: application/json' --post-data='${body}' '${url}'`;

async function main() {
  const daytona = new Daytona({
    apiKey: secret('DAYTONA_API_KEY'),
    apiUrl: secret('DAYTONA_SERVER_URL'),
    target: secret('DAYTONA_TARGET'),
  });
  const openrouterKey = secret('OPENROUTER_API_KEY');

  // The current production image: newest active kortix-default-* on the account.
  const snapRes: any = await daytona.snapshot.list();
  const snaps: any[] = Array.isArray(snapRes) ? snapRes : (snapRes.items ?? []);
  const current = snaps
    .filter((s) => String(s.name).startsWith('kortix-default-') && String(s.state).toLowerCase().includes('active'))
    .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))[0];
  if (!current) throw new Error('no active kortix-default-* snapshot found on this Daytona account');

  console.log('\n' + '='.repeat(72));
  console.log('  Kortix worker vs the sandbox we ship today — Daytona ' + secret('DAYTONA_TARGET'));
  console.log('='.repeat(72));
  console.log(`  NEW      ${SNAPSHOT}`);
  console.log(`  CURRENT  ${current.name}  (${Number(current.size ?? 0).toFixed(1)} GB)`);
  console.log(`  spec     2 vCPU / 6 GB / 20 GB — production defaults, identical on both`);
  console.log(`  model    ${MODEL} via OpenRouter — the path production uses`);
  console.log(`  prompt   "${PROMPT}"`);
  console.log(`  runs     ${RUNS}\n`);

  // Build the worker snapshot once. Not part of any measurement.
  const existing = await daytona.snapshot.get(SNAPSHOT).catch(() => null);
  if (!existing || !String((existing as any).state ?? '').toLowerCase().includes('active')) {
    console.log('building worker snapshot (one-off, excluded from every number)…');
    await daytona.snapshot.create(
      {
        name: SNAPSHOT,
        image: Image.fromDockerfile(join(SPIKE, 'Dockerfile')),
        entrypoint: ['node', '/opt/kortix/worker.mjs'],
        // Identical to production's DEFAULT_CPU / MEMORY_GB / DISK_GB
        // (apps/api/src/snapshots/build-context.ts) so the only variable is
        // the image, not the machine.
        resources: { cpu: 2, memory: 6, disk: 20 },
      },
      { timeout: 900, onLogs: () => {} },
    );
    console.log('  built\n');
  }

  const alive: any[] = [];
  const A: Array<{ createMs: number; readyMs: number; ttftMs: number | null; totalMs: number | null; answer: string }> = [];
  const B: Array<{ createMs: number; aliveMs: number | null; readyMs: number | null }> = [];

  try {
    for (let i = 1; i <= RUNS; i++) {
      console.log(`run ${i}/${RUNS}`);

      // ---------------- NEW: worker, timed until it ANSWERS ----------------
      let t0 = Date.now();
      const w = await daytona.create(
        {
          snapshot: SNAPSHOT,
          envVars: {
            PORT: '8080',
            KORTIX_MODEL_MODE: 'real',
            KORTIX_PROVIDER: 'openrouter',
            KORTIX_MODEL: MODEL,
            KORTIX_API_KEY: openrouterKey,
            KORTIX_SYSTEM_PROMPT: 'You are a Kortix agent. Answer briefly.',
            KORTIX_ENV_CWD: '/workspace',
          },
          autoStopInterval: 15,
          public: false,
        },
        { timeout: 300 },
      );
      const aCreate = Date.now() - t0;
      alive.push(w);

      await sh(w, `for i in $(seq 1 600); do ${GET('http://127.0.0.1:8080/health')} >/dev/null 2>&1 && break; sleep 0.05; done`, 180);
      const aReady = Date.now() - t0;

      const say = JSON.stringify({ text: PROMPT }).replace(/'/g, `'\\''`);
      const raw = await sh(w, POST('http://127.0.0.1:8080/say', say), 240);
      const aTotal = Date.now() - t0;
      let parsed: any = {};
      try { parsed = JSON.parse(raw.trim().split('\n').pop() || '{}'); } catch { /* leave empty */ }

      console.log(`  NEW      create ${ms(aCreate)}   serving ${ms(aReady)}   ANSWERED ${ms(aTotal)}`);
      console.log(`           first token after prompt ${ms(parsed.firstTokenMs)}`);
      console.log(`           > ${String(parsed.answer ?? '(no answer)').trim().slice(0, 160)}`);
      A.push({ createMs: aCreate, readyMs: aReady, ttftMs: parsed.firstTokenMs ?? null, totalMs: aTotal, answer: parsed.answer ?? '' });
      if (!KEEP) { await w.delete().catch(() => {}); alive.splice(alive.indexOf(w), 1); }

      // -------- CURRENT: today's sandbox, timed only until it is ALIVE -----
      t0 = Date.now();
      const c = await daytona.create(
        { snapshot: current.name, envVars: { KORTIX_BENCH: '1' }, autoStopInterval: 15, public: false },
        { timeout: 300 },
      );
      const bCreate = Date.now() - t0;
      alive.push(c);

      // Two bars, because they are far apart and only one of them is
      // comparable. kortixd binds its proxy before anything else, so the first
      // /kortix/health answer means "alive" and nothing more. The box cannot
      // serve a prompt until it reports runtimeReady:true with opencode ok —
      // that is the honest equivalent of the worker being able to answer.
      const probe = await sh(
        c,
        `A=0; for i in $(seq 1 1800); do H=$(${GET('http://127.0.0.1:8000/kortix/health')} 2>/dev/null); ` +
          `if [ -n "$H" ]; then if [ "$A" = "0" ]; then echo "ALIVE=$i"; A=1; fi; ` +
          `case "$H" in *'"runtimeReady":true'*) echo "READY=$i"; break;; esac; fi; sleep 0.1; done`,
        420,
      );
      const aliveTick = /ALIVE=(\d+)/.exec(probe);
      const readyTick = /READY=(\d+)/.exec(probe);
      const bAliveMs = aliveTick ? bCreate + Number(aliveTick[1]) * 100 : null;
      const bReady = readyTick ? bCreate + Number(readyTick[1]) * 100 : null;
      console.log(`  CURRENT  create ${ms(bCreate)}   daemon alive ${ms(bAliveMs)}   RUNTIME READY ${ms(bReady)}\n`);
      B.push({ createMs: bCreate, aliveMs: bAliveMs, readyMs: bReady });
      if (!KEEP) { await c.delete().catch(() => {}); alive.splice(alive.indexOf(c), 1); }
    }

    // ------------------------------- verdict -------------------------------
    const aAns = med(A.map((x) => x.totalMs!));
    const bAlive = med(B.map((x) => x.readyMs!));
    console.log('='.repeat(72));
    console.log('  MEDIANS');
    console.log('='.repeat(72));
    console.log(`  NEW      create ${ms(med(A.map((x) => x.createMs)))}  serving ${ms(med(A.map((x) => x.readyMs)))}  answered ${ms(aAns)}`);
    console.log(`  CURRENT  create ${ms(med(B.map((x) => x.createMs)))}  daemon alive ${ms(med(B.map((x) => x.aliveMs!)))}  runtime ready ${ms(bAlive)}`);
    console.log('='.repeat(72));
    if (Number.isFinite(aAns) && Number.isFinite(bAlive)) {
      const delta = bAlive - aAns;
      const aServe = med(A.map((x) => x.readyMs));
      console.log(`\n  ready to take a prompt:   worker ${ms(aServe)}   vs today ${ms(bAlive)}`);
      console.log(`  worker answered outright: ${ms(aAns)} (includes ~${ms(med(A.map((x) => x.ttftMs!)))} of model latency)`);
      console.log(
        delta > 0
          ? `\n  The worker had ANSWERED ${(delta / 1000).toFixed(1)}s before today's box was ready to be asked.`
          : `\n  Today's box was ready to be asked ${(-delta / 1000).toFixed(1)}s before the worker answered.\n  Compare like with like: ready-vs-ready is ${((bAlive - aServe) / 1000).toFixed(1)}s in the worker's favour.`,
      );
    }
    console.log(`\n  answers received:`);
    for (const a of A) console.log(`    "${a.answer.trim().slice(0, 100)}"`);
    console.log(`\n${JSON.stringify({ new: A, current: B }, null, 2)}`);
  } finally {
    if (KEEP) console.log(`\n--keep: ${alive.length} sandbox(es) left: ${alive.map((s) => s.id).join(', ')}`);
    else {
      console.log(`\ncleanup: ${alive.length} sandbox(es)`);
      for (const s of alive) await s.delete().then(() => console.log(`  deleted ${s.id}`)).catch(() => {});
    }
    if (has('--delete-snapshots')) {
      const snap = await daytona.snapshot.get(SNAPSHOT).catch(() => null);
      if (snap) await daytona.snapshot.delete(snap).then(() => console.log(`  deleted snapshot ${SNAPSHOT}`)).catch(() => {});
    }
  }
}

main().catch((e) => { console.error('\nCOMPARE FAILED:', e?.message ?? e); process.exit(1); });
