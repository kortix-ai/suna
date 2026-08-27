/**
 * Phase 0 · S0.1 — "tool replacement holds".
 *
 * The claim under test is NOT "the agent can write a file". It is:
 *
 *     the agent writes files, runs shell commands, and reads results —
 *     and the worker's own disk is untouched.
 *
 * The negative assertion is the test. A run that creates the file in the
 * environment but ALSO leaves anything behind locally is a failure, because
 * that is exactly how the split silently collapses back into today's one box.
 */
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readdirSync, statSync, existsSync } from 'node:fs';
import { startStubEnvironment } from '../src/stub-environment.ts';
import { buildHarness, type WorkerConfig } from '../src/worker.ts';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';

/** Recursive snapshot of a directory: relative path → size+mtime. */
function snapshot(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string, base: string) => {
    for (const name of readdirSync(d)) {
      if (name === 'node_modules' || name === '.git') continue;
      const full = join(d, name);
      const rel = base ? `${base}/${name}` : name;
      const st = statSync(full);
      if (st.isDirectory()) walk(full, rel);
      else out.set(rel, `${st.size}:${Math.floor(st.mtimeMs)}`);
    }
  };
  walk(dir, '');
  return out;
}

function diff(before: Map<string, string>, after: Map<string, string>) {
  const added: string[] = [], changed: string[] = [], removed: string[] = [];
  for (const [k, v] of after) { if (!before.has(k)) added.push(k); else if (before.get(k) !== v) changed.push(k); }
  for (const k of before.keys()) if (!after.has(k)) removed.push(k);
  return { added, changed, removed };
}

const results: Array<{ name: string; pass: boolean; detail: string }> = [];
const check = (name: string, pass: boolean, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? '  PASS' : '  FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

async function main() {
  const envRoot = await mkdtemp(join(tmpdir(), 'kortix-env-'));
  const workerCwd = await mkdtemp(join(tmpdir(), 'kortix-worker-cwd-'));
  // Give the worker's local disk some pre-existing content so "unchanged"
  // is a meaningful statement and not just "an empty dir stayed empty".
  await mkdir(join(workerCwd, 'local'), { recursive: true });
  await writeFile(join(workerCwd, 'local', 'preexisting.txt'), 'do not touch\n');

  const stub = await startStubEnvironment({ root: envRoot });
  console.log(`\nenvironment  ${stub.url}  root=${envRoot}`);
  console.log(`worker cwd   ${workerCwd}\n`);

  const originalCwd = process.cwd();
  process.chdir(workerCwd);

  const cfg: WorkerConfig = {
    port: 0,
    envUrl: stub.url,
    envCwd: '/workspace',
    systemPrompt: 'test',
    modelMode: 'faux',
  };
  const { agent, env, faux } = await buildHarness(cfg);

  const before = snapshot(workerCwd);

  // --- turn 1: the agent writes a file, then runs a shell command on it ----
  faux!.setResponses([
    fauxAssistantMessage([fauxToolCall('write', { path: '/workspace/proof.txt', content: 'written-by-agent\n' })], { stopReason: 'toolUse' }),
    fauxAssistantMessage([fauxToolCall('bash', { command: 'wc -c < /workspace/proof.txt && uname -s' })], { stopReason: 'toolUse' }),
    fauxAssistantMessage([fauxToolCall('read', { path: '/workspace/proof.txt' })], { stopReason: 'toolUse' }),
    fauxAssistantMessage('done', { stopReason: 'stop' }),
  ]);

  await agent.prompt('write proof.txt, measure it, read it back');

  const after = snapshot(workerCwd);
  process.chdir(originalCwd);

  // ---------------------------------------------------------------- asserts
  console.log('\nassertions');

  const ops = env.calls.map((c) => c.op);
  check('every tool call crossed the RPC boundary', ops.length > 0, `${ops.length} RPC ops: ${[...new Set(ops)].join(', ')}`);
  check('shell executed through the environment, not locally', ops.includes('exec'));
  check('write executed through the environment', ops.includes('writeFile'));

  const envFile = join(envRoot, 'workspace', 'proof.txt');
  const landed = existsSync(envFile);
  check('the file exists in the ENVIRONMENT', landed, landed ? await readFile(envFile, 'utf8').then((s) => JSON.stringify(s)) : 'missing');

  const d = diff(before, after);
  const clean = d.added.length === 0 && d.changed.length === 0 && d.removed.length === 0;
  check(
    'the WORKER disk is byte-for-byte unchanged',
    clean,
    clean ? 'no files added, changed, or removed' : `added=${JSON.stringify(d.added)} changed=${JSON.stringify(d.changed)} removed=${JSON.stringify(d.removed)}`,
  );

  const strayLocal = existsSync(join(workerCwd, 'proof.txt')) || existsSync(join(workerCwd, 'workspace'));
  check('no agent artifact anywhere on the worker', !strayLocal);

  
  await stub.close();
  await rm(envRoot, { recursive: true, force: true });
  await rm(workerCwd, { recursive: true, force: true });

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) { console.log('S0.1 FAILED'); process.exit(1); }
  console.log('S0.1 PASSED — the harness/environment split holds at the ExecutionEnv seam.');
}

main().catch((e) => { console.error(e); process.exit(1); });
