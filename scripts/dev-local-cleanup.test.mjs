import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, chmodSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(import.meta.dirname, '..');
const alive = pid => {
  try { process.kill(pid, 0); } catch { return false; }
  return spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim().match(/^[^Z]/) !== null;
};

for (const signal of [null, 'SIGTERM', 'SIGINT', 'build failure']) {
  test(`laptop shutdown cleans pipeline and rotated tunnel children (${signal ?? 'normal exit'})`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dev-cleanup-'));
    const bin = join(dir, 'bin'); mkdirSync(bin);
    const script = join(root, 'scripts', `.dev-cleanup-${process.pid}.sh`);
    const pidsFile = join(dir, 'pids');
    const stub = (name, body) => { const p = join(bin, name); writeFileSync(p, `#!/bin/bash\n${body}\n`); chmodSync(p, 0o755); };
    const record = 'echo "$BASHPID" >> "$STATE/pids"';
    stub('docker', 'exit 0'); stub('lsof', 'exit 1'); stub('bun', 'exit 0');
    stub('pkill', 'exit 0'); stub('pgrep', 'exit 0');
    stub('sleep', 'exec /bin/sleep 0.02');
    stub('curl', 'case "$*" in *trycloudflare.com*) [[ -f "$STATE/rotated" ]] ;; *) exit 0 ;; esac');
    stub('cloudflared', `${record}
n=$(cat "$STATE/count" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > "$STATE/count"
[[ "$n" -gt 1 ]] && touch "$STATE/rotated"
echo "https://stub-$n.trycloudflare.com"
exec /bin/sleep 120`);
    stub('stripe', `${record}\nexec /bin/sleep 120`);
    stub('pnpm', `case "$*" in
*llm-gateway-server*) ${record}; /bin/sleep 120 & echo "$!" >> "$STATE/pids"; wait ;;
*next*build*) touch "$STATE/ready"; /bin/sleep 0.1; exit 7 ;;
*kortix-api*dev*)
  if [[ -f "$STATE/rotated" ]]; then
    touch "$STATE/ready"
    [[ "$MODE" == normal ]] && exit 0
  fi
  /bin/sleep 0.1 ;;
esac`);
    writeFileSync(script, readFileSync(join(root, 'scripts/dev-local.sh'), 'utf8')
      .replace('if [[ -d /opt/kortix || -n "${KORTIX_SESSION_ID:-}" ]]; then', 'if false; then')
      .replace(/^load_local_env$/m, ':'));
    const unrelated = spawn('/bin/sleep', ['120'], { stdio: 'ignore' });
    const child = spawn('bash', [script, ...(signal === 'build failure' ? ['--build'] : [])], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: {
      PATH: `${bin}:${process.env.PATH}`, HOME: process.env.HOME, STATE: dir,
      MODE: signal ? 'signal' : 'normal', ALLOWED_SANDBOX_PROVIDERS: 'daytona',
      KORTIX_BILLING_INTERNAL_ENABLED: 'true', STRIPE_SECRET_KEY: 'synthetic',
      SUPABASE_URL: 'https://example.test', DATABASE_URL: 'postgresql://example.test/db',
    } });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const exited = new Promise(resolve => child.on('exit', (code, sig) => resolve({ code, sig })));
    try {
      for (let i = 0; i < 200 && !existsSync(join(dir, 'ready')); i++) await delay(10);
      assert.ok(existsSync(join(dir, 'ready')), `startup reached: ${output}`);
      if (signal && signal !== 'build failure') child.kill(signal);
      const result = await Promise.race([exited, delay(5000).then(() => null)]);
      assert.ok(result, 'shutdown finishes within five seconds');
      assert.equal(result.code, signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : signal === 'build failure' ? 7 : 0);
      const pids = readFileSync(pidsFile, 'utf8').trim().split('\n').map(Number);
      assert.ok(pids.length >= (signal === 'build failure' ? 4 : 5), 'initial tunnel, rotated tunnel, Stripe and gateway descendants started');
      for (let i = 0; i < 100 && pids.some(alive); i++) await delay(10);
      assert.deepEqual(pids.filter(alive), [], 'no owned daemon survives');
      assert.ok(alive(unrelated.pid), 'unrelated process survives');
    } finally {
      child.kill('SIGKILL'); unrelated.kill('SIGKILL');
      if (existsSync(pidsFile)) for (const pid of readFileSync(pidsFile, 'utf8').trim().split('\n').map(Number)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
      rmSync(script, { force: true }); rmSync(dir, { recursive: true, force: true });
    }
  });
}
