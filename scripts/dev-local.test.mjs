// Black-box tests for scripts/dev-local.sh's tunnel skip paths: the real
// script runs under bash; only the leaf processes the flow cannot provide
// here (dev servers, cloudflared, docker) come from stubs on PATH. The
// supervised API start is observed through a recording `pnpm` stub, so the
// assertions cover what the script passes to its children.
//
// Regression (KRTX-1455): with KORTIX_DEV_TUNNEL=0 or a preset healthy
// KORTIX_URL, ensure_dev_tunnel returned without TUNNEL_URL_FILE and the
// supervised API loop crashed on the unbound variable before starting the
// API. A started quick tunnel keeps its watchdog: it must still rotate a
// dead tunnel and bounce the API with the new URL.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SCRIPT = join(ROOT, 'scripts', 'dev-local.sh');
const API_PORT = '8008';
const SANDBOX_GUARD = 'if [[ -d /opt/kortix || -n "${KORTIX_SESSION_ID:-}" ]]; then';

function stub(dir, name, body) {
  const path = join(dir, name);
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

// Build one isolated run: a temp state dir, the stub PATH, and a copy of the
// real script with only the sandbox-mode guard forced off (that guard is an
// environment property of the box, not the code under test — the laptop flow
// is). The copy sits directly in scripts/ so the script's ROOT_DIR
// (dirname/..) still resolves to this checkout.
function runDevLocal(caseEnv) {
  const bin = mkdtempSync(join(tmpdir(), 'dev-local-stubs-'));
  const state = join(bin, 'state');
  mkdirSync(state);
  mkdirSync(join(ROOT, 'output'), { recursive: true });
  const scriptCopy = join(ROOT, 'scripts', `.dev-local-harness-${process.pid}-${Date.now()}.sh`);

  const src = readFileSync(SCRIPT, 'utf8');
  assert.ok(src.includes(SANDBOX_GUARD), 'dev-local.sh sandbox guard moved; update this harness');
  const harness = src
    .replace(SANDBOX_GUARD, 'if false; then # test harness: force the laptop flow')
    .replace(/^load_local_env$/m, ': # test harness: env loading stubbed for determinism');
  assert.ok(harness.includes('if false; then'), 'harness rewrite failed');
  assert.ok(!/^load_local_env$/m.test(harness), 'harness rewrite failed');
  writeFileSync(scriptCopy, harness);

  stub(bin, 'docker', '#!/bin/sh\nexit 0\n');
  stub(bin, 'lsof', '#!/bin/sh\nexit 1\n');
  stub(bin, 'sleep', '#!/bin/sh\nexec /bin/sleep 0.05\n');
  stub(bin, 'bun', '#!/bin/sh\nexit 0\n');
  stub(bin, 'pnpm', `#!/bin/sh
printf '%s|KORTIX_URL=%s\\n' "$*" "\${KORTIX_URL-<unset>}" >> "$PNPM_LOG"
case "$*" in *kortix-api*dev*) exec /bin/sleep 2 ;; esac
exit 0
`);
  stub(bin, 'curl', `#!/bin/sh
case "$*" in
  *trycloudflare.com/health*)
    n=$(cat "$STUB_STATE/tunnel-probes" 2>/dev/null || echo 0)
    n=$((n+1)); echo "$n" > "$STUB_STATE/tunnel-probes"
    [ "$n" -ge 3 ] && exit 0
    exit 1 ;;
  *) exit 0 ;;
esac
`);
  stub(bin, 'pgrep', '#!/bin/sh\nexit "$PGREP_ALIVE"\n');
  stub(bin, 'pkill', '#!/bin/sh\nexit 0\n');
  stub(bin, 'cloudflared', `#!/bin/sh
n=$(cat "$STUB_STATE/cloudflared-n" 2>/dev/null || echo 0)
n=$((n+1)); echo "$n" > "$STUB_STATE/cloudflared-n"
echo "[stub] tunnel up: https://stub-tunnel-\$n.trycloudflare.com"
`);

  const pnpmLog = join(state, 'pnpm.log');
  const env = {
    PATH: `${bin}:${process.env.PATH}`,
    HOME: process.env.HOME ?? '/tmp',
    LANG: 'C.UTF-8',
    STUB_STATE: state,
    PNPM_LOG: pnpmLog,
    PORT: API_PORT,
    WEB_PORT: '3000',
    ALLOWED_SANDBOX_PROVIDERS: 'daytona',
    KORTIX_DEV_GATEWAY: '0',
    KORTIX_STRIPE_LISTEN: '0',
    SUPABASE_URL: 'https://supabase.example.test',
    DATABASE_URL: 'postgresql://db.example.test:5432/db',
    PGREP_ALIVE: '1',
    ...caseEnv,
  };
  const r = spawnSync('bash', [scriptCopy], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    timeout: 60_000,
  });
  let pnpmCalls = [];
  try {
    pnpmCalls = readFileSync(pnpmLog, 'utf8').trim().split('\n');
  } finally {
    rmSync(scriptCopy, { force: true });
    rmSync(bin, { recursive: true, force: true });
  }
  return {
    status: r.status,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    pnpmCalls,
  };
}

const apiStarts = (r) => r.pnpmCalls.filter((line) => line.includes('--filter kortix-api dev'));

test('bash -n: the script parses', () => {
  const r = spawnSync('bash', ['-n', SCRIPT], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});

test('KORTIX_DEV_TUNNEL=0: the API starts on the local origin instead of an unbound-variable crash', () => {
  const r = runDevLocal({ KORTIX_DEV_TUNNEL: '0' });
  const output = r.stdout + r.stderr;
  assert.match(output, /Tunnel skipped/);
  assert.doesNotMatch(output, /unbound variable/);
  assert.equal(r.status, 0, output);
  assert.deepEqual(apiStarts(r), [
    `--filter kortix-api dev|KORTIX_URL=http://localhost:${API_PORT}`,
  ]);
  // No quick tunnel was started, so no watchdog may run: a started watchdog
  // would (re)establish a tunnel the operator explicitly switched off.
  assert.doesNotMatch(output, /DEAD\/MISSING/);
  assert.equal(r.pnpmCalls.filter((line) => line.includes('--filter Kortix-Computer-Frontend')).length, 1);
});

test('preset healthy KORTIX_URL: the API starts with that URL instead of an unbound-variable crash', () => {
  const r = runDevLocal({ KORTIX_URL: 'https://preset.example.test' });
  const output = r.stdout + r.stderr;
  assert.match(output, /Using KORTIX_URL from environment/);
  assert.doesNotMatch(output, /unbound variable/);
  assert.equal(r.status, 0, output);
  assert.deepEqual(apiStarts(r), [
    '--filter kortix-api dev|KORTIX_URL=https://preset.example.test',
  ]);
  assert.doesNotMatch(output, /DEAD\/MISSING/);
});

test('started quick tunnel: the watchdog still rotates a dead tunnel and bounces the API', () => {
  const r = runDevLocal({ PGREP_ALIVE: '0' });
  const output = r.stdout + r.stderr;
  assert.match(output, /Cloud sandbox callback ready/);
  assert.match(output, /tunnel rotated/);
  assert.equal(r.status, 0, output);
  // First spawn bakes tunnel 1, the rotation bounces the API onto tunnel 2.
  const urls = apiStarts(r).map((line) => line.split('KORTIX_URL=')[1]);
  assert.deepEqual(urls, [
    'https://stub-tunnel-1.trycloudflare.com',
    'https://stub-tunnel-2.trycloudflare.com',
  ]);
});
