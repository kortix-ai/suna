/**
 * Process-tree reaping for worktree stacks.
 *
 * A running stack is not three processes, it is three TREES. `pnpm --filter … dev`
 * forks a package-manager shim, which forks a dotenvx wrapper, which forks the dev
 * server, which forks a worker pool — Next dev alone leaves ~15 (`webpack-loaders`,
 * `postcss`, an esbuild service). Only the leaf holds the port.
 *
 * Stopping by "kill whatever listens on the port" therefore reclaimed 3 of ~19
 * processes and silently leaked the rest. Leaked workers reparent to launchd, keep
 * their (1–3 GB, Turbopack never shrinks) heap, lose their terminal, and can no
 * longer be reached by Ctrl+C or by `stop` — so they live until reboot. A few of
 * those and the machine dies of swap exhaustion; the OOM kill then takes the
 * supervisor with it, orphaning yet another stack. That is the loop this closes.
 *
 * Design notes:
 * - Roots are discovered from OBSERVABLE state only (cwd, port listeners, command
 *   line). We deliberately do NOT persist pids at start: a stale pid file plus pid
 *   reuse means signalling a stranger, and the registry has already proven it
 *   drifts from reality.
 * - Every kill is VERIFIED. Callers use the survivor list to decide what to record,
 *   because a status written on an unverified kill is what made `list` lie.
 * - `process.kill` is used directly rather than shelling out to kill(1), so a
 *   failure surfaces as an exception instead of a swallowed non-zero exit.
 */
import { sh } from './exec';

export interface ProcRow {
  pid: number;
  ppid: number;
  command: string;
}

export interface KillResult {
  /** Every pid we signalled, roots and descendants alike. */
  targeted: number[];
  /** Targets still alive after SIGTERM → SIGKILL. Non-empty means DO NOT record "stopped". */
  survived: number[];
}

/** Parse `ps -Ao pid=,ppid=,command=`. Tolerates leading pad and spaces in the command. */
export function parsePsTable(stdout: string): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const line of stdout.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3].trim() });
  }
  return rows;
}

/** Parse `lsof -a -d cwd -Fpn` — alternating `p<pid>` / `n<path>` records. */
export function parseLsofCwd(stdout: string): Array<{ pid: number; cwd: string }> {
  const out: Array<{ pid: number; cwd: string }> = [];
  let pid = 0;
  for (const line of stdout.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1)) || 0;
    else if (line.startsWith('n') && pid) out.push({ pid, cwd: line.slice(1) });
  }
  return out;
}

/**
 * Path containment that respects segment boundaries — `…/suna-web` must never be
 * treated as living inside `…/suna-w`, or one worktree's stop would reap another's.
 */
export function isUnder(path: string, dir: string): boolean {
  const d = dir.replace(/\/+$/, '');
  return path === d || path.startsWith(`${d}/`);
}

/** Roots plus every descendant, breadth-first. Cycle-safe (a bad ps snapshot can self-parent). */
export function expandTree(roots: number[], rows: ProcRow[]): number[] {
  const children = new Map<number, number[]>();
  for (const r of rows) {
    if (r.ppid === r.pid) continue;
    const list = children.get(r.ppid);
    if (list) list.push(r.pid);
    else children.set(r.ppid, [r.pid]);
  }
  const seen = new Set<number>();
  const queue = [...roots];
  for (let i = 0; i < queue.length; i++) {
    const pid = queue[i];
    if (seen.has(pid)) continue;
    seen.add(pid);
    for (const child of children.get(pid) ?? []) if (!seen.has(child)) queue.push(child);
  }
  return [...seen];
}

/** The pid's parent chain up to init. Used to keep a reaper from killing its own shell. */
export function ancestorsOf(pid: number, rows: ProcRow[]): number[] {
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const out: number[] = [];
  let cur = byPid.get(pid);
  const seen = new Set<number>([pid]);
  while (cur && cur.ppid > 1 && !seen.has(cur.ppid)) {
    out.push(cur.ppid);
    seen.add(cur.ppid);
    cur = byPid.get(cur.ppid);
  }
  return out;
}

/**
 * Expand roots to full trees, then remove everything we must not signal: pid 0/1,
 * ourselves, and our own ancestors. The self-exclusion is load-bearing — `stop` run
 * from a shell whose cwd is inside the worktree matches its own cwd probe, and
 * without this the reaper would kill the terminal it was typed into.
 */
export function planKill(opts: { roots: number[]; rows: ProcRow[]; selfPid: number }): number[] {
  const { roots, rows, selfPid } = opts;
  const protectedPids = new Set<number>([0, 1, selfPid, ...ancestorsOf(selfPid, rows)]);
  // Prune protected pids from the SEEDS, not just the result. The reaper's own cwd
  // is inside the worktree and its argv[0] is `bun`, so discovery legitimately
  // returns it as a root; expanding through it would then sweep up the very `ps`
  // child that produced this table. Seeds handed in explicitly (the start
  // supervisor passing its own spawned servers) are unaffected — they are not the
  // reaper itself.
  const seeds = roots.filter((pid) => !protectedPids.has(pid));
  return expandTree(seeds, rows).filter((pid) => pid > 1 && !protectedPids.has(pid));
}

/**
 * Command shapes that belong to a dev stack.
 *
 * The cwd probe on its own is too broad: a shell pipeline, an editor, `git`, or a
 * coding agent working in the worktree all share its working directory. An early
 * version of this reaper took cwd as sufficient and killed the `grep` on the other
 * end of its own output pipe — the stop ran, but silently, because its reader was
 * dead. So a cwd match only makes something a ROOT if it also looks like the
 * toolchain; anything else dies only by being a descendant of something that does.
 */
const DEV_BINARIES = new Set([
  'node',
  'bun',
  'pnpm',
  'npm',
  'yarn',
  'next',
  'next-server',
  'esbuild',
  'dotenvx',
]);
const SIDECAR_BINARIES = new Set(['cloudflared', 'stripe']);

/**
 * The binary being executed, ignoring its arguments.
 *
 * Matching anywhere in the command line is not good enough: `zsh -c '… node foo.js'`
 * mentions node, and treating that as a stack root would reap the user's shell. Only
 * argv[0] decides — every real stack process runs the toolchain binary directly.
 */
export function executableOf(command: string): string {
  const argv0 = command.trim().split(/\s+/)[0] ?? '';
  return argv0.slice(argv0.lastIndexOf('/') + 1);
}

export function isDevStackProcess(command: string): boolean {
  return DEV_BINARIES.has(executableOf(command));
}

/** pids whose command line targets `http://localhost:<port>` — the tunnel and stripe forwarder. */
export function sidecarPids(rows: ProcRow[], apiPort: number): number[] {
  const target = new RegExp(`localhost:${apiPort}(?![0-9])`);
  return rows
    .filter((r) => SIDECAR_BINARIES.has(executableOf(r.command)) && target.test(r.command))
    .map((r) => r.pid);
}

export interface CwdRow {
  pid: number;
  cwd: string;
}

export function psTable(): ProcRow[] {
  return parsePsTable(sh(['ps', '-Ao', 'pid=,ppid=,command=']).stdout);
}

/**
 * Working directory of every process on the box, in one shot. Callers that scan
 * many worktrees fetch this once and pass it down — a per-worktree lsof would be
 * ~55 full scans on this machine.
 */
export function cwdTable(): CwdRow[] {
  return parseLsofCwd(sh(['bash', '-lc', 'lsof -a -d cwd -Fpn 2>/dev/null || true']).stdout);
}

/** Every process whose working directory is inside `dir`. */
export function cwdOwners(dir: string, rows?: CwdRow[]): number[] {
  return (rows ?? cwdTable()).filter((r) => isUnder(r.cwd, dir)).map((r) => r.pid);
}

/** All pids listening on a port — `portInUse` returns only the first, which hid siblings. */
export function listenersOn(port: number): number[] {
  const out = sh([
    'bash',
    '-lc',
    `lsof -nP -tiTCP:${port} -sTCP:LISTEN 2>/dev/null || true`,
  ]).stdout;
  return out
    .split('\n')
    .map((s) => Number(s.trim()))
    .filter((n) => n > 1);
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means it exists but belongs to someone else; only ESRCH proves it is gone.
    return (e as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

/**
 * Every process belonging to a worktree's stack, found three independent ways
 * because no single probe sees all of it:
 *  - cwd inside the worktree → the dev servers and their whole worker pool;
 *  - listening on a slot port → anything that outlived its parent and still binds;
 *  - command line pointing at the slot's API port → cloudflared / `stripe listen`,
 *    which run from the CLI's own cwd and so are invisible to the cwd probe.
 */
export function stackRoots(
  worktreePath: string,
  ports: { web: number; api: number; gateway: number },
  tables: { rows?: ProcRow[]; cwds?: CwdRow[] } = {},
): number[] {
  const rows = tables.rows ?? psTable();
  const roots = new Set<number>([
    ...devCwdOwners(worktreePath, rows, tables.cwds),
    ...listenersOn(ports.web),
    ...listenersOn(ports.api),
    ...listenersOn(ports.gateway),
    ...sidecarPids(rows, ports.api),
  ]);
  return [...roots];
}

/** cwd owners that also look like the dev toolchain — see DEV_PROCESS. */
function devCwdOwners(worktreePath: string, rows: ProcRow[], cwds?: CwdRow[]): number[] {
  const commands = new Map(rows.map((r) => [r.pid, r.command]));
  return cwdOwners(worktreePath, cwds).filter((pid) => isDevStackProcess(commands.get(pid) ?? ''));
}

/**
 * Cheap liveness probe for reporting across every registered worktree: cwd and
 * sidecars only, from tables the caller already fetched. Skips the per-port lsof
 * that `stackRoots` does, which would be 3 scans per worktree.
 *
 * Reports the same set `stop` would kill (roots plus descendants, minus the caller
 * and its ancestors) so the count reflects the real footprint — counting roots
 * alone understated a stack by ~60%, which is the number that matters when the
 * question is "what is eating my memory".
 */
export function stackPids(
  worktreePath: string,
  apiPort: number,
  tables: { rows: ProcRow[]; cwds: CwdRow[] },
  selfPid = process.pid,
): number[] {
  const roots = [
    ...devCwdOwners(worktreePath, tables.rows, tables.cwds),
    ...sidecarPids(tables.rows, apiPort),
  ];
  return planKill({ roots, rows: tables.rows, selfPid });
}

function signalAll(pids: number[], signal: NodeJS.Signals): void {
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone, or not ours — the verification pass is what decides.
    }
  }
}

async function waitGone(pids: number[], ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!pids.some(alive)) return;
    await Bun.sleep(100);
  }
}

/**
 * Signal a whole tree and prove it died: SIGTERM, wait out the grace period, then
 * SIGKILL whatever ignored it. Survivors are returned rather than thrown so the
 * caller can refuse to record a stop that did not happen.
 */
export async function killTree(
  roots: number[],
  opts: { rows?: ProcRow[]; graceMs?: number } = {},
): Promise<KillResult> {
  const rows = opts.rows ?? psTable();
  const targeted = planKill({ roots, rows, selfPid: process.pid });
  if (!targeted.length) return { targeted: [], survived: [] };

  signalAll(targeted, 'SIGTERM');
  await waitGone(targeted, opts.graceMs ?? 3000);

  const stubborn = targeted.filter(alive);
  if (stubborn.length) {
    signalAll(stubborn, 'SIGKILL');
    await waitGone(stubborn, 1500);
  }
  return { targeted, survived: targeted.filter(alive) };
}
