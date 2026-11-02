import type { Config } from '@/lib/config/config'

/** The daemon's HTTP server (app/server.ts), as an adapter's boot holds it. */
export interface DaemonServer {
  stop(): Promise<void>
  port: number
  // Rebuild the control surface with a new Config. A warm snapshot seed boots
  // with seed-time credentials and only learns its forked session cfg after
  // restore; without this the proxy auth gate + routers keep the seed cfg.
  reload(next: Config): void
}

/**
 * Stop the daemon cleanly, and choose the exit code (app/shutdown.ts).
 *
 * The code is load-bearing for the entrypoint supervisor: `75` means "install
 * the staged binary and start me again", anything else non-zero counts against
 * the failure budget that triggers a rollback. See
 * apps/sandbox/entrypoint.sh and src/services/runtime-assets/runtime-assets.ts.
 *
 * A self-update MUST come through here rather than calling `process.exit`
 * directly: this path flushes drive changes and the session log, shreds the
 * agent env file and stops the harness before the exit. A bare exit skips all
 * of it.
 */
export interface DaemonShutdown {
  (opts: { reason: string; exitCode?: number; signal?: NodeJS.Signals }): void
}
