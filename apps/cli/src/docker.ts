/**
 * Minimal local-Docker probing for CLI commands that shell out to `docker`.
 *
 * Deliberately tiny and dependency-free: two questions, answered the same way
 * every time. (`self-host.ts` has its own inline `docker --version` probe from
 * before this existed; leaving it alone here keeps this change to one surface.)
 */
import { spawnSync } from 'node:child_process';

/**
 * Is there a usable Docker on this machine RIGHT NOW?
 *
 * Both probes are required. `docker --version` only proves the CLI binary is on
 * PATH — it exits 0 with the daemon stopped, which is the single most common
 * way this fails on a laptop ("Docker Desktop isn't running"). `docker info`
 * is the one that actually talks to the daemon.
 */
export function dockerAvailable(): boolean {
  for (const args of [['--version'], ['info']]) {
    const r = spawnSync('docker', args, { encoding: 'utf8', stdio: 'ignore' });
    if (r.error || r.status !== 0) return false;
  }
  return true;
}

/**
 * The Linux container platform this host builds natively — `linux/arm64` on
 * Apple Silicon / ARM machines, `linux/amd64` everywhere else (and as the
 * fallback for an arch we don't map, which is what Docker itself would do).
 *
 * Native is the right DEFAULT for a local build even though the cloud is always
 * linux/amd64: an emulated amd64 build of the Kortix layer (texlive +
 * libreoffice + chromium under QEMU) takes hours on an M-series Mac, and a gate
 * nobody waits for gates nothing. Callers print the mismatch and offer
 * `--platform linux/amd64` for an exact match.
 */
export function hostPlatform(): string {
  return process.arch === 'arm64' ? 'linux/arm64' : 'linux/amd64';
}
