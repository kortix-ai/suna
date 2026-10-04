import { spawnSync } from 'node:child_process';
import type { LocalTopology } from './local-stack';

// The CLI and MCP server can both start the app. Neither may take another checkout's ports.
export function assertAgenticListenerOwnership(topology: LocalTopology): void {
  for (const port of [
    topology.marker?.ports.web ?? 3000,
    topology.marker?.ports.api ?? 8008,
    topology.marker?.ports.gateway ?? 8090,
  ]) {
    const listeners = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp'], {
      encoding: 'utf8',
    });
    if (
      listeners.error ||
      (listeners.status !== 0 && listeners.status !== 1) ||
      (listeners.status === 1 && listeners.stderr.trim())
    ) {
      throw new Error(`cannot inspect port ${port}`, { cause: listeners.error });
    }
    const pids = new Set(listeners.stdout.match(/^p\d+$/gm) ?? []);
    for (const pid of pids) {
      const process = spawnSync('lsof', ['-a', '-p', pid.slice(1), '-d', 'cwd', '-Fn'], {
        encoding: 'utf8',
      });
      const cwd = process.stdout
        .split('\n')
        .find((line) => line.startsWith('n'))
        ?.slice(1);
      if (!cwd || (cwd !== topology.root && !cwd.startsWith(`${topology.root}/`))) {
        throw new Error(
          `port ${port} belongs to another checkout; reassign this worktree before starting tests`,
        );
      }
    }
  }
}
