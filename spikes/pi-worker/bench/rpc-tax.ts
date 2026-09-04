/**
 * GATE G0 — the RPC tax. Runs BEFORE P1.1.
 *
 * WHY THIS IS A GATE AND NOT AN IMPLEMENTATION NOTE.
 *
 * Splitting the harness from the environment turns every tool call into a
 * network round trip. `bash` is a local fork today: about a millisecond.
 * The first Daytona measurement put a per-call `fetch` at ~67 ms, and a
 * 200-tool-call turn at +13 s — on EVERY turn, forever, against a one-off
 * boot saving of 1.3-2.8 s. On that number the split is a net regression for
 * tool-heavy work, and no amount of Phase 1 makes it not one.
 *
 * So this is the question that decides whether P1.1 is worth writing.
 *
 * THE THRESHOLD.
 *
 *   pass  p50 <= 10 ms  a 200-call turn pays <= 2 s, comfortably under the
 *                       boot saving. Net win everywhere.
 *   warn  p50 <= 25 ms  a 200-call turn pays 5 s. Net win only for sessions
 *                       that are not tool-heavy. Ship, but scope the
 *                       reduction work before tool-heavy agents move over.
 *   fail  p50  > 25 ms  a 200-call turn pays more than the split saves.
 *                       Do not write P1.1 against this transport.
 *
 * Measured worker -> provider edge -> environment, which is the shape
 * production uses (worker -> Kortix proxy -> sandbox daemon), from inside the
 * worker sandbox so the benchmark host's distance never enters the number.
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
const GET = (u: string) => `(command -v curl >/dev/null 2>&1 && curl -sf --max-time 5 '${u}') || wget -qO- '${u}'`;

const CALLS = Number(process.argv.find((a) => a.startsWith('--calls='))?.split('=')[1] ?? 200);
const LOCAL = process.argv.includes('--local');
const W_SNAP = 'kortix-worker-rpc-v1';
const E_SNAP = 'kortix-env-rpc-v1';

const p = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((q / 100) * s.length))];
};
const verdict = (p50: number) => (p50 <= 10 ? 'PASS' : p50 <= 25 ? 'WARN' : 'FAIL');

/** The measuring script, run INSIDE the worker sandbox. */
const measureJs = (envUrl: string, headers: string, calls: number) => `
const { makeTransport } = await import('/opt/kortix/rpc-transport.mjs');
const HEADERS = ${headers};
const results = {};
for (const kind of ['fetch', 'keepalive', 'ws']) {
  const t = makeTransport(kind, ${JSON.stringify(envUrl)}, HEADERS);
  try {
    for (let i = 0; i < 20; i++) await t.call('exec', { command: 'true' }, '/workspace'); // warm
    const xs = [];
    for (let i = 0; i < ${calls}; i++) {
      const s = process.hrtime.bigint();
      const r = await t.call('exec', { command: 'true' }, '/workspace');
      if (!r || r.ok !== true) throw new Error(kind + ': bad response ' + JSON.stringify(r).slice(0, 120));
      xs.push(Number(process.hrtime.bigint() - s) / 1e6);
    }
    results[kind] = xs;
  } catch (e) {
    results[kind] = { error: String(e && e.message || e) };
  } finally { await t.close().catch(() => {}); }
}
console.log('RPCTAX=' + JSON.stringify(results));
`;

async function main() {
  console.log('\n' + '='.repeat(70));
  console.log('  GATE G0 — the RPC tax (runs before P1.1)');
  console.log('='.repeat(70));
  console.log(`  ${CALLS} calls per transport, after 20 warm-up calls`);
  console.log(`  pass <= 10 ms p50 · warn <= 25 ms · fail > 25 ms\n`);

  let raw: string;
  let where: string;

  if (LOCAL) {
    console.log('  [local] starting stub environment…');
    const { startStubEnvironment } = await import('../src/stub-environment.ts');
    const { makeTransport } = await import('../src/rpc-transport.ts');
    const { mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const env = await startStubEnvironment({ root: await mkdtemp(join(tmpdir(), 'kx-rpc-')) });
    console.log(`  [local] env ${env.url}`);
    where = 'localhost (loopback — a floor, not a prediction)';
    const results: Record<string, any> = {};
    for (const kind of ['fetch', 'keepalive', 'ws'] as const) {
      console.log(`  [local] measuring ${kind}…`);
      const t = makeTransport(kind, env.url);
      try {
        for (let i = 0; i < 20; i++) await t.call('exec', { command: 'true' }, '/workspace');
        const xs: number[] = [];
        for (let i = 0; i < CALLS; i++) {
          const s = process.hrtime.bigint();
          await t.call('exec', { command: 'true' }, '/workspace');
          xs.push(Number(process.hrtime.bigint() - s) / 1e6);
        }
        results[kind] = xs;
      } catch (e: any) { results[kind] = { error: String(e?.message ?? e) }; }
      finally { await t.close(); }
    }
    await env.close();
    raw = 'RPCTAX=' + JSON.stringify(results);
  } else {
    const daytona = new Daytona({
      apiKey: secret('DAYTONA_API_KEY'), apiUrl: secret('DAYTONA_SERVER_URL'), target: secret('DAYTONA_TARGET'),
    });
    const ensure = async (name: string, dockerfile: string, entry: string[]) => {
      const s = await daytona.snapshot.get(name).catch(() => null);
      if (s && String((s as any).state ?? '').toLowerCase().includes('active')) return;
      console.log(`  building ${name}…`);
      await daytona.snapshot.create(
        { name, image: Image.fromDockerfile(join(SPIKE, dockerfile)), entrypoint: entry, resources: { cpu: 2, memory: 4, disk: 10 } },
        { timeout: 900, onLogs: () => {} },
      );
    };
    await ensure(W_SNAP, 'Dockerfile', ['node', '/opt/kortix/worker.mjs']);
    await ensure(E_SNAP, 'Dockerfile.environment', ['node', '/opt/kortix/environment.mjs']);

    const boxes: any[] = [];
    try {
      const envBox = await daytona.create({ snapshot: E_SNAP, envVars: { PORT: '8100', ENV_ROOT: '/env-root' }, autoStopInterval: 15 }, { timeout: 300 });
      boxes.push(envBox);
      const link = await envBox.getPreviewLink(8100);
      const headers = link.token ? JSON.stringify({ 'x-daytona-preview-token': link.token }) : '{}';
      where = 'Daytona: worker -> provider edge -> environment';

      const w = await daytona.create({ snapshot: W_SNAP, envVars: { PORT: '8080' }, autoStopInterval: 15 }, { timeout: 300 });
      boxes.push(w);
      await sh(w, `for i in $(seq 1 900); do ${GET('http://127.0.0.1:8080/health')} >/dev/null 2>&1 && break; sleep 0.1; done`);

      await sh(w, `cat > /tmp/m.mjs <<'KXEOF'\n${measureJs(link.url, headers, CALLS)}\nKXEOF`);
      raw = await sh(w, 'node /tmp/m.mjs', 900);
    } finally {
      for (const b of boxes) await b.delete().catch(() => {});
      console.log(`  (deleted ${boxes.length} sandboxes)`);
    }
  }

  const m = /RPCTAX=(\{[\s\S]*\})/.exec(raw);
  if (!m) { console.error('no measurement returned:\n' + raw.slice(0, 800)); process.exit(1); }
  const data = JSON.parse(m[1]);

  console.log(`\nmeasured on ${where}\n`);
  console.log('  transport    p50        p95        per 200-call turn   verdict');
  console.log('  ' + '-'.repeat(64));
  const summary: Record<string, number> = {};
  for (const kind of ['fetch', 'keepalive', 'ws']) {
    const xs = data[kind];
    if (!Array.isArray(xs)) { console.log(`  ${kind.padEnd(12)} ERROR: ${xs?.error}`); continue; }
    const p50 = p(xs, 50), p95 = p(xs, 95);
    summary[kind] = p50;
    console.log(
      `  ${kind.padEnd(12)} ${(p50.toFixed(1) + ' ms').padEnd(10)} ${(p95.toFixed(1) + ' ms').padEnd(10)} ` +
        `${((p50 * 200) / 1000).toFixed(1)}s`.padEnd(19) + ` ${verdict(p50)}`,
    );
  }
  console.log('  ' + '-'.repeat(64));

  const best = Object.entries(summary).sort((a, b) => a[1] - b[1])[0];
  if (!best) { console.log('\nGATE G0: no transport produced a measurement.'); process.exit(1); }
  const [bestKind, bestP50] = best;
  const v = verdict(bestP50);
  console.log(`\n  best transport: ${bestKind} at ${bestP50.toFixed(1)} ms p50`);
  console.log(`\nGATE G0: ${v}`);
  if (v === 'PASS') console.log('  A 200-call turn pays ' + ((bestP50 * 200) / 1000).toFixed(1) + 's, under the boot saving. P1.1 may proceed.');
  else if (v === 'WARN') console.log('  Net win only for sessions that are not tool-heavy. Scope the reduction work before tool-heavy agents move over.');
  else console.log('  A 200-call turn costs more than the split saves. Do NOT write P1.1 against this transport.');
  console.log('\n' + JSON.stringify({ gate: 'G0', where, calls: CALLS, p50: summary, verdict: v }, null, 2));
  if (v === 'FAIL') process.exit(1);
}

main().catch((e) => { console.error('\nGATE G0 FAILED TO RUN:', e?.message ?? e); process.exit(1); });
