import { spawn } from 'bun';
import { mkdtempSync, openSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, which } from './exec';

// A log file inside a freshly-created private temp dir — mkdtempSync makes the
// dir atomically with an unpredictable name at mode 0700, so no other local user
// can pre-create or read it. Matters because these logs capture a child's
// stdout/stderr and the stripe one holds the `whsec_` signing secret; a fixed
// name in the shared tmpdir would be a symlink/disclosure risk.
function privateLogFile(prefix: string): string {
  return join(mkdtempSync(join(tmpdir(), `kortix-wt-${prefix}-`)), `${prefix}.log`);
}

export async function ensureRuntimeArtifacts(worktreePath: string): Promise<number> {
  const builds: Array<[string, string]> = [
    ['sandbox agent', '@kortix/sandbox-agent-server'],
    ['CLI', '@kortix/cli'],
  ];
  for (const [label, filter] of builds) {
    console.log(`  building ${label} runtime artifact`);
    const code = await run(['pnpm', '--filter', filter, 'build'], { cwd: worktreePath });
    if (code !== 0) return code;
  }
  return 0;
}

export interface Tunnel { url: string; proc: ReturnType<typeof Bun.spawn>; }

export async function startTunnel(apiPort: number): Promise<Tunnel | null> {
  if (!which('cloudflared')) return null;
  const logPath = privateLogFile('tunnel');
  const fd = openSync(logPath, 'w', 0o600);
  const proc = spawn(['cloudflared', 'tunnel', '--no-autoupdate', '--url', `http://localhost:${apiPort}`], {
    stdout: fd, stderr: fd, stdin: 'ignore',
  });
  const re = /https:\/\/[a-z0-9.-]+\.trycloudflare\.com/;
  for (let i = 0; i < 30; i++) {
    const m = readFileSync(logPath, 'utf8').match(re);
    if (m) return { url: m[0], proc };
    if (proc.exitCode !== null) break;
    await Bun.sleep(1000);
  }
  try { proc.kill(); } catch {}
  return null;
}

export interface StripeListen { secret: string; proc: ReturnType<typeof Bun.spawn>; }

// Forward Stripe (test-mode) webhooks to THIS worktree's API — the shared
// `pnpm stripe:listen` is hardcoded to :8008, so without this a worktree's
// checkout/subscription webhooks would never reach its own API. Captures the
// `whsec_…` signing secret `stripe listen` prints so the handler can verify
// signatures. Returns null if the stripe CLI is missing or not logged in
// (`stripe login`), in which case it just times out.
export async function startStripeListen(apiPort: number): Promise<StripeListen | null> {
  if (!which('stripe')) return null;
  const forwardTo = `http://localhost:${apiPort}/v1/billing/webhooks/stripe`;
  const logPath = privateLogFile('stripe');
  const fd = openSync(logPath, 'w', 0o600);
  const proc = spawn(['stripe', 'listen', '--forward-to', forwardTo], {
    stdout: fd, stderr: fd, stdin: 'ignore',
  });
  const re = /whsec_[A-Za-z0-9]+/;
  for (let i = 0; i < 20; i++) {
    const m = readFileSync(logPath, 'utf8').match(re);
    if (m) return { secret: m[0], proc };
    if (proc.exitCode !== null) break;   // not logged in / errored out
    await Bun.sleep(1000);
  }
  try { proc.kill(); } catch {}
  return null;
}
