import { spawn, spawnSync } from 'bun';

export interface ShResult {
  code: number;
  stdout: string;
  stderr: string;
  ok: boolean;
}

export function sh(
  cmd: string[],
  opts: { cwd?: string; env?: Record<string, string> } = {},
): ShResult {
  const r = spawnSync(cmd, {
    cwd: opts.cwd,
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    code: r.exitCode,
    stdout: r.stdout?.toString() ?? '',
    stderr: r.stderr?.toString() ?? '',
    ok: r.exitCode === 0,
  };
}

export async function run(
  cmd: string[],
  opts: { cwd?: string; env?: Record<string, string> } = {},
): Promise<number> {
  const p = spawn(cmd, {
    cwd: opts.cwd,
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
    stdout: 'inherit',
    stderr: 'inherit',
    stdin: 'inherit',
  });
  return await p.exited;
}

export function which(bin: string): string | null {
  const r = sh(['bash', '-lc', `command -v ${bin} || true`]);
  const out = r.stdout.trim();
  return out || null;
}

export function portInUse(port: number): { inUse: boolean; pid?: string; cmd?: string } {
  const r = sh(['bash', '-lc', `lsof -nP -iTCP:${port} -sTCP:LISTEN -Fpcn 2>/dev/null || true`]);
  if (!r.stdout.trim()) return { inUse: false };
  const pid = r.stdout.match(/^p(\d+)/m)?.[1];
  const cmd = r.stdout.match(/^c(.+)$/m)?.[1];
  return { inUse: true, pid, cmd };
}
