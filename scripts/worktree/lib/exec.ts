import { spawnSync, spawn } from 'bun';

export interface ShResult { code: number; stdout: string; stderr: string; ok: boolean; }

export function sh(cmd: string[], opts: { cwd?: string; env?: Record<string, string> } = {}): ShResult {
  const r = spawnSync(cmd, {
    cwd: opts.cwd,
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
    stdout: 'pipe', stderr: 'pipe',
  });
  return {
    code: r.exitCode,
    stdout: r.stdout?.toString() ?? '',
    stderr: r.stderr?.toString() ?? '',
    ok: r.exitCode === 0,
  };
}

export async function run(cmd: string[], opts: { cwd?: string; env?: Record<string, string> } = {}): Promise<number> {
  const p = spawn(cmd, {
    cwd: opts.cwd,
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
    stdout: 'inherit', stderr: 'inherit', stdin: 'inherit',
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

/**
 * Wait until a throwaway Postgres container serves the host endpoint the suite
 * will actually use. The probe is host-side `psql`, never `pg_isready` inside
 * the container: the postgres entrypoint runs initdb against a temporary
 * socket-only server, so the in-container probe answers while nothing serves
 * TCP yet (the incident behind the comment in tests/migration/
 * worktree-migrate.test.ts). The default budget is generous because the
 * db-suites lane starts six containers while the api-cli-flows lane boots the
 * Supabase stack, and a loaded host has crossed a 60 s budget.
 */
export async function waitForPostgresReady(url: string, seconds = 150): Promise<void> {
  for (let i = 0; i < seconds; i++) {
    if (sh(['psql', url, '-tAc', 'select 1']).ok) return;
    await Bun.sleep(1000);
  }
  throw new Error(`test Postgres never became ready: ${url}`);
}
