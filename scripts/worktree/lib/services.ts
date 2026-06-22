import { spawn } from 'bun';
import { run, which } from './exec';

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

// Drain a spawned process's stdout+stderr and resolve the first regex match (the
// tunnel URL and the stripe signing secret both print to the child's output).
// Piping in-memory avoids a temp file entirely — no predictable /tmp path to leak
// the `whsec_` secret through and no create-then-read race. The process is left
// running on a match; the caller owns its lifecycle (and kills it on miss).
async function waitForOutputMatch(
  proc: ReturnType<typeof Bun.spawn>,
  re: RegExp,
  attempts: number,
): Promise<string | null> {
  let buf = '';
  const pump = async (stream: ReadableStream<Uint8Array> | null | undefined) => {
    if (!stream) return;
    const dec = new TextDecoder();
    try {
      for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
        buf += dec.decode(chunk, { stream: true });
      }
    } catch { /* stream closed when the process is killed */ }
  };
  void pump(proc.stdout as ReadableStream<Uint8Array>);
  void pump(proc.stderr as ReadableStream<Uint8Array>);
  for (let i = 0; i < attempts; i++) {
    const m = buf.match(re);
    if (m) return m[0];
    if (proc.exitCode !== null) break;
    await Bun.sleep(1000);
  }
  return null;
}

export interface Tunnel { url: string; proc: ReturnType<typeof Bun.spawn>; }

export async function startTunnel(apiPort: number): Promise<Tunnel | null> {
  if (!which('cloudflared')) return null;
  const proc = spawn(['cloudflared', 'tunnel', '--no-autoupdate', '--url', `http://localhost:${apiPort}`], {
    stdout: 'pipe', stderr: 'pipe', stdin: 'ignore',
  });
  const url = await waitForOutputMatch(proc, /https:\/\/[a-z0-9.-]+\.trycloudflare\.com/, 30);
  if (url) return { url, proc };
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
  const proc = spawn(['stripe', 'listen', '--forward-to', forwardTo], {
    stdout: 'pipe', stderr: 'pipe', stdin: 'ignore',
  });
  const secret = await waitForOutputMatch(proc, /whsec_[A-Za-z0-9]+/, 20);
  if (secret) return { secret, proc };
  try { proc.kill(); } catch {}
  return null;
}
