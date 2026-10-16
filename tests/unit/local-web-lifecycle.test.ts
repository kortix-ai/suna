import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const run = promisify(execFile);
const modulePath = resolve(import.meta.dirname, '../src/core/local-stack.ts');

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing test port');
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

/** Exercise the real Bun process boundary with a disposable HTTP dev server. */
async function exerciseWeb(body: string, survivingChild = false, failFirstReplacement = false, unreadyReplacement = false): Promise<{ output: string; launches: string[] }> {
  const directory = await mkdtemp(join(tmpdir(), 'kortix-local-web-'));
  const port = await availablePort();
  const launchesPath = join(directory, 'launches');
  const serverPath = join(directory, 'server.ts');
  await writeFile(serverPath, `
process.on('SIGTERM', () => {});
Bun.serve({ port: ${port}, hostname: '127.0.0.1', fetch: () => new Response('child') });
`);
  await writeFile(join(directory, 'pnpm'), `#!/usr/bin/env bun
import { appendFileSync, readFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(launchesPath)}, process.pid + '\\n');
${failFirstReplacement ? `if (readFileSync(${JSON.stringify(launchesPath)}, 'utf8').trim().split('\\n').length === 2) process.exit(1);` : ''}
process.on('SIGTERM', () => process.exit(0));
${unreadyReplacement ? `if (readFileSync(${JSON.stringify(launchesPath)}, 'utf8').trim().split('\\n').length > 1) await new Promise(() => setInterval(() => {}, 1000));` : ''}
${survivingChild ? `Bun.spawn(['bun', ${JSON.stringify(serverPath)}], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' }); setInterval(() => {}, 1000);` : `Bun.serve({ port: ${port}, hostname: '127.0.0.1', fetch: () => new Response('ready') });`}
`);
  await chmod(join(directory, 'pnpm'), 0o755);
  const program = `
import { ensureLocalWeb, localTopology, localWebHealthy } from ${JSON.stringify(modulePath)};
import { readFileSync, unlinkSync } from 'node:fs';
const url = 'http://localhost:${port}';
const topology = localTopology(${JSON.stringify(directory)}, {
  path: ${JSON.stringify(directory)}, branch: 'test', ports: { web: ${port}, api: 18008, gateway: 18090 },
});
const options = { autoStart: true, supabase: { API_URL: 'http://127.0.0.1:54321', ANON_KEY: 'test' } };
const launches = () => readFileSync(${JSON.stringify(launchesPath)}, 'utf8').trim().split('\\n').map(Number);
const waitFor = async (predicate) => {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await Bun.sleep(20);
  }
  return false;
};
let handle;
let recoveredCount = 0;
let exhausted = false;
const report = console.error;
console.error = (...args) => {
  if (String(args[0]).includes('recovery exhausted')) exhausted = true;
  if (String(args[0]).includes('local web recovered at')) recoveredCount++;
  report(...args);
};
try {
  handle = await ensureLocalWeb(topology, options);
  ${body}
} finally {
  await handle?.stop();
  for (const pid of launches()) {
    try { process.kill(-pid, 'SIGKILL'); } catch {}
  }
}
process.exit(0);
`;
  try {
    const { stdout } = await run('bun', ['-e', program], {
      env: { ...process.env, PATH: `${directory}:${process.env.PATH}` },
      timeout: 15_000,
    });
    return { output: stdout, launches: (await readFile(launchesPath, 'utf8')).trim().split('\n') };
  } finally {
    const pids = await readFile(launchesPath, 'utf8').catch(() => '');
    for (const pid of pids.trim().split('\n').filter(Boolean).map(Number)) {
      try { process.kill(-pid, 'SIGKILL'); } catch {}
    }
    await rm(directory, { recursive: true, force: true });
  }
}

describe('runner-owned local web lifecycle', () => {
  it('restores HTTP service after the owned server exits cleanly during a suite', async () => {
    const result = await exerciseWeb(`
process.kill(launches()[0], 'SIGTERM');
const recovered = await waitFor(async () => launches().length === 2 && await localWebHealthy(url));
console.log(JSON.stringify({ recovered }));
`);
    expect(result.output).toContain('"recovered":true');
    expect(result.launches).toHaveLength(2);
  });

  it('uses the remaining recovery budget when a replacement exits before readiness', async () => {
    const result = await exerciseWeb(`
process.kill(launches()[0], 'SIGTERM');
const recovered = await waitFor(async () => launches().length === 3 && await localWebHealthy(url));
console.log(JSON.stringify({ recovered }));
`, false, true);
    expect(result.output).toContain('"recovered":true');
    expect(result.launches).toHaveLength(3);
  });

  it('exhausts recovery safely when the replacement cannot spawn', async () => {
    const result = await exerciseWeb(`
unlinkSync(process.env.PATH.split(':')[0] + '/pnpm');
process.env.PATH = '/nonexistent';
process.kill(launches()[0], 'SIGTERM');
if (!await waitFor(() => exhausted)) throw new Error('recovery did not exhaust');
await handle.stop();
console.log(JSON.stringify({ exhausted, healthy: await localWebHealthy(url) }));
`);
    expect(result.output).toContain('"exhausted":true,"healthy":false');
    expect(result.launches).toHaveLength(1);
  });

  it('keeps a reused server outside the runner ownership boundary', async () => {
    const result = await exerciseWeb(`
const reused = await ensureLocalWeb(topology, options);
await reused.stop();
console.log(JSON.stringify({ started: reused.started, healthy: await localWebHealthy(url) }));
`);
    expect(result.output).toContain('"started":false,"healthy":true');
    expect(result.launches).toHaveLength(1);
  });

  it('bounds recovery when a server repeatedly exits after readiness', async () => {
    const result = await exerciseWeb(`
for (let count = 1; count <= 4; count++) {
  if (!await waitFor(async () => launches().length === count && recoveredCount === count - 1 && await localWebHealthy(url))) {
    throw new Error('server was not ready for exit ' + count);
  }
  process.kill(launches()[count - 1], 'SIGTERM');
}
await Bun.sleep(300);
console.log(JSON.stringify({ healthy: await localWebHealthy(url) }));
`);
    expect(result.output).toContain('"healthy":false');
    expect(result.launches).toHaveLength(4);
  });

  it('reaps a surviving HTTP child when its wrapper exits during shutdown', async () => {
    const result = await exerciseWeb(`
await handle.stop();
console.log(JSON.stringify({ healthy: await localWebHealthy(url) }));
`, true);
    expect(result.output).toContain('"healthy":false');
    expect(result.launches).toHaveLength(1);
  });

  it('stops a replacement that has not become ready without launching again', async () => {
    const result = await exerciseWeb(`
process.kill(launches()[0], 'SIGTERM');
if (!await waitFor(async () => launches().length === 2)) throw new Error('replacement not launched');
if (await localWebHealthy(url)) throw new Error('replacement unexpectedly ready');
await handle.stop();
await Bun.sleep(300);
console.log(JSON.stringify({ healthy: await localWebHealthy(url) }));
`, false, false, true);
    expect(result.output).toContain('"healthy":false');
    expect(result.launches).toHaveLength(2);
  });

  it('does not restart a server stopped by the runner', async () => {
    const result = await exerciseWeb(`
await handle.stop();
await Bun.sleep(300);
console.log(JSON.stringify({ healthy: await localWebHealthy(url) }));
`);
    expect(result.output).toContain('"healthy":false');
    expect(result.launches).toHaveLength(1);
  });
});
