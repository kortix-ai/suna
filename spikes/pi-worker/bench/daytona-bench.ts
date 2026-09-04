/**
 * Daytona benchmark — how long until the agent says its first word?
 *
 * Standalone. Touches nothing in apps/, nothing in the UI, no Kortix API, no
 * database. It builds a Daytona snapshot from the worker image, boots real
 * sandboxes from it, measures, and deletes everything it created.
 *
 * WHAT IS MEASURED, AND WHY IT IS MEASURED THIS WAY
 *
 *   create() -> running  The provider allocating and starting the box,
 *                        measured on the benchmark host's clock.
 *
 *   process -> serving   Node start to the worker accepting connections,
 *                        captured ONCE at listen inside the worker.
 *
 *                        NOTE: the gap between these two is not observable
 *                        from inside a sandbox. /proc/uptime is virtualized in
 *                        Daytona and disagrees with the process clock read
 *                        microseconds later (280 ms vs 513 ms), so it is not
 *                        reported here. That gap is exactly what P1.0's
 *                        API-side clock exists to measure, and this benchmark
 *                        is independent evidence that it cannot be measured
 *                        any other way.
 *
 *   ttft                 Request start to the first streamed chunk carrying
 *                        assistant text, measured from inside the sandbox so
 *                        the benchmark host's distance to Daytona is not in
 *                        the figure.
 *
 *   tool round trip      One bash tool call, worker -> environment, across two
 *                        separate sandboxes. This is the plan's biggest
 *                        regression risk: bash is a local fork today.
 *
 * With the default faux model, ttft measures INFRASTRUCTURE ONLY — boot plus
 * dispatch. That is deliberate: provider latency is identical before and after
 * the split, so including it only adds noise to the thing being decided. Pass
 * --real with KORTIX_API_KEY set for the absolute end-user number.
 */
import { Daytona, Image } from '@daytonaio/sdk';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SPIKE = resolve(HERE, '..');
const REPO = resolve(SPIKE, '..', '..');

const argv = new Set(process.argv.slice(2));
const REAL = argv.has('--real');
const KEEP = argv.has('--keep');
const RUNS = Number(process.argv.find((a) => a.startsWith('--runs='))?.split('=')[1] ?? 3);
const SNAPSHOT = process.env.BENCH_SNAPSHOT ?? 'kortix-worker-bench-v1';
const ENV_SNAPSHOT = `${SNAPSHOT}-env`;

/** Read a dotenvx-encrypted value without ever writing it to disk. */
const secret = (key: string): string => {
  const v = execFileSync('dotenvx', ['get', key, '-f', '.env'], {
    cwd: join(REPO, 'apps', 'api'),
    encoding: 'utf8',
  }).trim();
  if (!v) throw new Error(`${key} is empty`);
  return v;
};

const ms = (n: number | null | undefined) => (n == null ? '  n/a' : `${String(Math.round(n)).padStart(5)} ms`);
const pct = (xs: number[], p: number) => {
  if (!xs.length) return Number.NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const stat = (label: string, xs: number[]) => {
  const clean = xs.filter((x) => Number.isFinite(x));
  if (!clean.length) return `${label.padEnd(26)} no samples`;
  return `${label.padEnd(26)} min ${ms(Math.min(...clean))}   med ${ms(pct(clean, 50))}   max ${ms(Math.max(...clean))}`;
};

async function ensureSnapshot(daytona: Daytona, name: string, dockerfile: string, entrypoint: string[]) {
  const existing = await daytona.snapshot.get(name).catch(() => null);
  if (existing && String((existing as any).state ?? '').toLowerCase().includes('active')) {
    console.log(`  snapshot ${name}: reusing existing`);
    return;
  }
  console.log(`  snapshot ${name}: building (one-off, not part of any measurement)`);
  const t0 = Date.now();
  await daytona.snapshot.create(
    {
      name,
      image: Image.fromDockerfile(join(SPIKE, dockerfile)),
      entrypoint,
      resources: { cpu: 1, memory: 1, disk: 3 },
    },
    { timeout: 600, onLogs: () => {} },
  );
  console.log(`  snapshot ${name}: built in ${Math.round((Date.now() - t0) / 1000)}s`);
}

/** Run a command inside the sandbox and return stdout. */
async function sh(sandbox: any, command: string): Promise<string> {
  const r = await sandbox.process.executeCommand(command);
  return String(r.result ?? '');
}

interface Sample {
  createMs: number;
  vmBootToServingMs: number | null;
  harnessBuildMs: number | null;
  ttftMs: number | null;
  turnMs: number | null;
  toolRoundTripMs: number | null;
}

async function main() {
  process.env.DAYTONA_API_KEY ??= secret('DAYTONA_API_KEY');
  const daytona = new Daytona({
    apiKey: process.env.DAYTONA_API_KEY,
    apiUrl: secret('DAYTONA_SERVER_URL'),
    target: secret('DAYTONA_TARGET'),
  });

  if (!existsSync(join(SPIKE, 'dist', 'worker.mjs'))) {
    throw new Error('dist/worker.mjs missing — run the bun build first (see README §2)');
  }

  console.log(`\nKortix worker — Daytona benchmark`);
  console.log(`runs=${RUNS}  model=${REAL ? 'real' : 'faux (infrastructure only)'}\n`);

  console.log('snapshots');
  await ensureSnapshot(daytona, SNAPSHOT, 'Dockerfile', ['node', '/opt/kortix/worker.mjs']);
  await ensureSnapshot(daytona, ENV_SNAPSHOT, 'Dockerfile.environment', ['node', '/opt/kortix/environment.mjs']);

  const created: any[] = [];
  const samples: Sample[] = [];

  try {
    // One long-lived environment sandbox, shared by every run: we are measuring
    // the WORKER's cold start, not the environment's.
    console.log('\nenvironment sandbox (shared across runs)');
    const envBox = await daytona.create(
      { snapshot: ENV_SNAPSHOT, envVars: { PORT: '8100', ENV_ROOT: '/env-root' }, autoStopInterval: 15, public: false },
      { timeout: 120 },
    );
    created.push(envBox);
    // Daytona isolates sandboxes from one another: a worker CANNOT reach an
    // environment by private IP (verified — EHOSTUNREACH, and the resulting
    // ~3.07s "round trip" was a TCP connect timeout, not latency). The
    // reachable path is the provider's own edge, which is also what production
    // uses: Kortix reaches sandboxes through /v1/p/<external_id>/8000/... So
    // the preview URL is not a workaround here, it is the representative
    // topology.
    const preview = await envBox.getPreviewLink(8100);
    console.log(`  up: ${envBox.id}  via provider edge`);

    for (let i = 1; i <= RUNS; i++) {
      console.log(`\nrun ${i}/${RUNS}`);
      const t0 = Date.now();
      const box = await daytona.create(
        {
          snapshot: SNAPSHOT,
          envVars: {
            PORT: '8080',
            KORTIX_ENV_URL: preview.url,
            ...(preview.token ? { KORTIX_ENV_HEADERS: JSON.stringify({ 'x-daytona-preview-token': preview.token }) } : {}),
            KORTIX_ENV_CWD: '/workspace',
            KORTIX_MODEL_MODE: REAL ? 'real' : 'faux',
            ...(REAL && process.env.KORTIX_API_KEY ? { KORTIX_API_KEY: process.env.KORTIX_API_KEY } : {}),
            ...(process.env.KORTIX_GATEWAY_URL ? { KORTIX_GATEWAY_URL: process.env.KORTIX_GATEWAY_URL } : {}),
          },
          autoStopInterval: 15,
          public: false,
        },
        { timeout: 120 },
      );
      const createMs = Date.now() - t0;
      created.push(box);
      console.log(`  created in ${createMs} ms  (${box.id})`);

      // Wait for the worker, then read ITS OWN view of when it started serving.
      const health = await sh(
        box,
        `for i in $(seq 1 400); do out=$(wget -qO- http://127.0.0.1:8080/health 2>/dev/null); if [ -n "$out" ]; then echo "$out"; exit 0; fi; sleep 0.05; done; echo '{}'`,
      );
      let vmBootToServingMs: number | null = null;
      let harnessBuildMs: number | null = null;
      try {
        const h = JSON.parse(health.trim().split('\n').pop() || '{}');
        vmBootToServingMs = null; // /proc/uptime is virtualized here — see header
        harnessBuildMs = h.bootMs ?? null;
      } catch { /* leave null */ }
      console.log(`  process start -> serving ${ms(harnessBuildMs)}`);

      // Time to first token, measured inside the box with node — busybox
      // `date` has no %N and shell SSE parsing is not worth the risk.
      const promptBody = REAL
        ? { text: 'Reply with exactly: ready' }
        : { text: 'go', script: [{ text: 'ready' }] };
      const toolBody = { text: 't', script: [{ tool: 'bash', args: { command: 'true' } }, { text: 'ok' }] };

      const measureJs = `
const http = require('node:http');
function post(path, body, firstTokenOnly) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body);
    const t0 = process.hrtime.bigint();
    let first = null;
    const req = http.request({ host: '127.0.0.1', port: 8080, path, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        if (first === null && (chunk.includes('text_delta') || chunk.includes('"type":"text"'))) {
          first = Number(process.hrtime.bigint() - t0) / 1e6;
        }
      });
      res.on('end', () => resolve({ first, total: Number(process.hrtime.bigint() - t0) / 1e6 }));
    });
    req.on('error', () => resolve({ first: null, total: null }));
    req.end(payload);
  });
}
(async () => {
  const turn = await post('/turn', ${JSON.stringify(promptBody)}, true);
  const tool = await post('/prompt', ${JSON.stringify(toolBody)}, false);
  console.log('RESULT=' + JSON.stringify({ ttft: turn.first, turn: turn.total, tool: tool.total }));
})();
`;
      await sh(box, `cat > /tmp/measure.js <<'KXEOF'\n${measureJs}\nKXEOF`);
      const out = await sh(box, 'node /tmp/measure.js');
      const m = /RESULT=(\{.*\})/.exec(out);
      const parsed = m ? JSON.parse(m[1]) : {};
      const ttftMs = parsed.ttft ?? null;
      const turnMs = parsed.turn ?? null;
      const toolRoundTripMs = parsed.tool ?? null;
      console.log(`  time to first token ${ms(ttftMs)}   (whole turn ${ms(turnMs)})`);
      console.log(`  bash tool round trip (worker -> edge -> environment) ${ms(toolRoundTripMs)}`);

      samples.push({ createMs, vmBootToServingMs, harnessBuildMs, ttftMs, turnMs, toolRoundTripMs });

      if (!KEEP) { await box.delete().catch(() => {}); created.splice(created.indexOf(box), 1); }
    }

    console.log(`\n${'='.repeat(66)}\nRESULTS  (${samples.length} runs, Daytona ${secret('DAYTONA_TARGET')}, 1 vCPU / 1 GB)\n${'='.repeat(66)}`);
    console.log(stat('daytona create() call', samples.map((s) => s.createMs)));
    console.log(stat('process start -> serving', samples.map((s) => s.harnessBuildMs!)));
    console.log(stat('time to first token', samples.map((s) => s.ttftMs!)));
    console.log(stat('whole turn', samples.map((s) => s.turnMs!)));
    console.log(stat('bash tool round trip', samples.map((s) => s.toolRoundTripMs!)));
    console.log('  worker -> provider edge -> environment. Production is the same');
    console.log('  shape: worker -> Kortix proxy -> sandbox daemon.');
    const med = pct(samples.map((s) => s.toolRoundTripMs!).filter(Number.isFinite), 50);
    if (Number.isFinite(med)) {
      console.log(`\n  AT THIS COST A 200-TOOL-CALL TURN PAYS ${(med * 200 / 1000).toFixed(1)}s,`);
      console.log('  on every turn, forever. bash is a local fork today (~1 ms).');
      console.log('  This is larger than the one-off boot saving and it is the');
      console.log('  finding that decides whether the split is a net win.');
    }
    console.log(`${'='.repeat(66)}`);
    console.log(
      REAL
        ? '\nreal model: ttft includes provider latency.'
        : '\nfaux model: ttft is INFRASTRUCTURE ONLY (boot + dispatch). Provider\nlatency is unchanged by the split and is deliberately excluded.',
    );
    console.log(JSON.stringify({ benchmark: 'kortix-worker-daytona', runs: samples }, null, 2));
  } finally {
    if (KEEP) {
      console.log(`\n--keep: leaving ${created.length} sandbox(es) alive: ${created.map((c) => c.id).join(', ')}`);
    } else {
      console.log(`\ncleanup: deleting ${created.length} sandbox(es)`);
      for (const box of created) {
        await box.delete().then(() => console.log(`  deleted ${box.id}`)).catch((e: any) => console.log(`  FAILED to delete ${box.id}: ${e?.message}`));
      }
      console.log('  (snapshots kept — reused by the next run; delete with --delete-snapshots)');
      if (argv.has('--delete-snapshots')) {
        for (const n of [SNAPSHOT, ENV_SNAPSHOT]) {
          // delete() wants the snapshot OBJECT, not { name } — passing a name
          // fails with "Required parameter id was null or undefined".
          const snap = await daytona.snapshot.get(n).catch(() => null);
          if (!snap) continue;
          await daytona.snapshot.delete(snap).then(() => console.log(`  deleted snapshot ${n}`)).catch(() => {});
        }
      }
    }
  }
}

main().catch((e) => { console.error('\nBENCHMARK FAILED:', e?.message ?? e); process.exit(1); });
