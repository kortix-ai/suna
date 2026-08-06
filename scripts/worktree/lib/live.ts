import { sh } from './exec';

/**
 * Which ports currently have a LISTEN socket, for the whole box, in one call.
 *
 * `list` needs liveness for every worktree at once and `portInUse` is one lsof
 * per port — 46 scans for 23 worktrees. A single field-mode scan costs ~70ms
 * and answers all of them, which is what makes a probed status column cheap
 * enough to be the default. (The `-d cwd` scan `status` uses costs ~534ms.)
 */
export function parseListenPorts(lsofFieldOutput: string): Set<number> {
  const ports = new Set<number>();
  for (const line of lsofFieldOutput.split('\n')) {
    // Field mode emits one record per line, prefixed by its field character;
    // `n` carries the address. Everything else (pid, fd) is noise here.
    if (line[0] !== 'n') continue;
    // Address forms are `*:15000`, `127.0.0.1:15000` and `[::1]:15000` — the
    // port is always the trailing colon-separated field, so anchor to the end
    // rather than splitting (an IPv6 literal is full of colons).
    const m = /:(\d+)$/.exec(line);
    if (m) ports.add(Number(m[1]));
  }
  return ports;
}

/**
 * Every listening port, or `null` when the probe itself is unavailable.
 *
 * `null` is not "nothing is listening" — it means callers must fall back to the
 * recorded registry status and say so, rather than reporting every worktree as
 * stopped because lsof is missing.
 */
export function listenPorts(): Set<number> | null {
  try {
    // Bun's spawnSync throws ENOENT for a missing binary rather than returning
    // a code, so the absent-lsof case lands in the catch.
    return parseListenPorts(sh(['lsof', '-nP', '-iTCP', '-sTCP:LISTEN', '-Fn']).stdout);
  } catch {
    return null;
  }
}
