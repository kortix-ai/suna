import { spawn } from 'node:child_process'
import { mkdirSync, openSync } from 'node:fs'
import { dirname } from 'node:path'
import { resolveSandboxOnBoot, type Config } from './config'
import { logger } from './logger'

/**
 * Project-declared boot command (`sandbox.on_boot` in kortix.yaml), e.g.
 * `pnpm dev` — run backgrounded once the repo is materialized and the proxy is
 * up, so a session auto-starts its dev stack with zero manual steps. Best
 * effort and harness-independent: a failure here never affects the agent
 * runtime. Output goes to a log file the agent/user can tail.
 */
export function runSandboxOnBoot(cfg: Config, logPath = '/var/log/kortix-on-boot.log'): void {
  void resolveSandboxOnBoot(cfg)
    .then((onBoot) => {
      if (!onBoot) return
      logger.info('[boot] running [sandbox] on_boot command', { onBoot, logPath })
      try {
        mkdirSync(dirname(logPath), { recursive: true })
      } catch {}
      const out = openSync(logPath, 'a')
      const child = spawn('bash', ['-lc', onBoot], {
        cwd: cfg.projectTarget,
        env: process.env,
        detached: true,
        stdio: ['ignore', out, out],
      })
      child.on('error', (err) => logger.warn('[boot] on_boot command failed to spawn', { err: (err as Error).message }))
      child.unref()
    })
    .catch((err) => logger.warn('[boot] on_boot resolution failed', { err: (err as Error).message }))
}
