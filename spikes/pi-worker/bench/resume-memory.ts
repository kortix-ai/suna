/**
 * The wrinkle from the archived-resume benchmark, closed.
 *
 * That run ended with the worker answering "I didn't resume from anything —
 * this is the start of our conversation." Correct, and the point: the spike
 * used an in-memory session, so the conversation died with the box.
 *
 * Same journey, with the durable store attached:
 *   tell it something -> stop -> ARCHIVE -> start -> ask it back.
 */
import { Daytona, Image } from '@daytonaio/sdk';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SPIKE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = resolve(SPIKE, '..', '..');
const secret = (k: string) =>
  execFileSync('dotenvx', ['get', k, '-f', '.env'], { cwd: join(REPO, 'apps', 'api'), encoding: 'utf8' }).trim();
const sh = async (b: any, c: string, t = 180) =>
  String((await b.process.executeCommand(c, undefined, undefined, t)).result ?? '');
const GET = (u: string) => `(command -v curl >/dev/null 2>&1 && curl -sf --max-time 5 '${u}') || wget -qO- '${u}'`;
const POST = (u: string, b: string) =>
  `(command -v curl >/dev/null 2>&1 && curl -sf --max-time 180 -H 'content-type: application/json' -d '${b}' '${u}') ` +
  `|| wget -qO- --header='content-type: application/json' --post-data='${b}' '${u}'`;

async function waitState(box: any, states: string[], label: string, timeoutMs = 900_000) {
  const t0 = Date.now();
  for (;;) {
    await box.refreshData().catch(() => {});
    const st = String((box as any).state ?? '').toLowerCase();
    if (states.includes(st)) return Date.now() - t0;
    if (st === 'error') throw new Error(`${label}: state=error`);
    if (Date.now() - t0 > timeoutMs) throw new Error(`${label}: timeout in ${st}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

const MODEL = process.argv.find((a) => a.startsWith('--model='))?.split('=')[1] ?? 'anthropic/claude-sonnet-4.5';
const WORKER_SNAP = 'kortix-worker-mem-v1';
const STORE_SNAP = 'kortix-store-mem-v1';

const daytona = new Daytona({
  apiKey: secret('DAYTONA_API_KEY'),
  apiUrl: secret('DAYTONA_SERVER_URL'),
  target: secret('DAYTONA_TARGET'),
});

const ensure = async (name: string, dockerfile: string, entry: string[]) => {
  const s = await daytona.snapshot.get(name).catch(() => null);
  if (s && String((s as any).state ?? '').toLowerCase().includes('active')) return;
  console.log(`  building ${name}…`);
  await daytona.snapshot.create(
    { name, image: Image.fromDockerfile(join(SPIKE, dockerfile)), entrypoint: entry, resources: { cpu: 1, memory: 2, disk: 5 } },
    { timeout: 900, onLogs: () => {} },
  );
};

const alive: any[] = [];
try {
  console.log('\nsnapshots');
  await ensure(WORKER_SNAP, 'Dockerfile', ['node', '/opt/kortix/worker.mjs']);
  await ensure(STORE_SNAP, 'Dockerfile.store', ['node', '/opt/kortix/store.mjs']);

  console.log('\nstore sandbox (survives the worker, as the control plane would)');
  const store = await daytona.create({ snapshot: STORE_SNAP, envVars: { PORT: '8200', STORE_ROOT: '/store' }, autoStopInterval: 0 }, { timeout: 300 });
  alive.push(store);
  const link = await store.getPreviewLink(8200);
  console.log(`  up: ${store.id}`);

  const SESSION = 'archived-resume-demo';
  const worker = await daytona.create(
    {
      snapshot: WORKER_SNAP,
      envVars: {
        PORT: '8080',
        KORTIX_MODEL_MODE: 'real',
        KORTIX_PROVIDER: 'openrouter',
        KORTIX_MODEL: MODEL,
        KORTIX_API_KEY: secret('OPENROUTER_API_KEY'),
        KORTIX_SYSTEM_PROMPT: 'You are a Kortix agent. Answer in one short sentence.',
        KORTIX_STORE_URL: link.url,
        KORTIX_SESSION_ID: SESSION,
        ...(link.token ? { KORTIX_STORE_HEADERS: JSON.stringify({ 'x-daytona-preview-token': link.token }) } : {}),
      },
      autoStopInterval: 0,
    },
    { timeout: 300 },
  );
  alive.push(worker);
  await sh(worker, `for i in $(seq 1 900); do ${GET('http://127.0.0.1:8080/health')} >/dev/null 2>&1 && break; sleep 0.1; done`, 300);
  console.log(`  worker up: ${worker.id}\n`);

  const say = async (b: any, text: string) => {
    const raw = await sh(b, POST('http://127.0.0.1:8080/say', JSON.stringify({ text })), 240);
    try { return JSON.parse(raw.trim().split('\n').pop() || '{}'); } catch { return {}; }
  };

  console.log('BEFORE ARCHIVE');
  const a1 = await say(worker, 'Remember this passphrase exactly: ORBITAL-LLAMA-7. Confirm you have it.');
  console.log(`  > ${String(a1.answer ?? '').trim()}`);

  console.log('\nstop -> archive -> start');
  await worker.stop();
  await waitState(worker, ['stopped'], 'stop');
  const tA = Date.now();
  await worker.archive();
  await waitState(worker, ['archived'], 'archive');
  console.log(`  archived in ${Math.round((Date.now() - tA) / 1000)}s`);
  const t0 = Date.now();
  await worker.start(600);
  await waitState(worker, ['started'], 'start');
  await sh(worker, `for i in $(seq 1 900); do ${GET('http://127.0.0.1:8080/health')} >/dev/null 2>&1 && break; sleep 0.1; done`, 300);
  console.log(`  back and serving in ${Date.now() - t0} ms`);

  const health = await sh(worker, GET('http://127.0.0.1:8080/health'));
  try {
    const h = JSON.parse(health.trim().split('\n').pop() || '{}');
    console.log(`  restored ${h.store?.restoredEntries ?? 0} entries from the store`);
  } catch { /* ignore */ }

  console.log('\nAFTER ARCHIVE — the question that failed last time');
  const a2 = await say(worker, 'What was the passphrase I gave you?');
  const answer = String(a2.answer ?? '').trim();
  console.log(`  > ${answer}`);
  const remembered = answer.includes('ORBITAL-LLAMA-7');
  console.log(`\n  ${remembered ? 'REMEMBERED' : 'FORGOT'} — the conversation ${remembered ? 'survived' : 'did not survive'} archive+resume.`);
} finally {
  console.log(`\ncleanup: ${alive.length} sandbox(es)`);
  for (const s of alive) await s.delete().then(() => console.log(`  deleted ${s.id}`)).catch(() => {});
  for (const n of [WORKER_SNAP, STORE_SNAP]) {
    const snap = await daytona.snapshot.get(n).catch(() => null);
    if (snap) await daytona.snapshot.delete(snap).then(() => console.log(`  deleted snapshot ${n}`)).catch(() => {});
  }
}
