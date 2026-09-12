import { dispatchCli, isManagementSubcommand } from './cli'
import { loadConfig } from './config'
import { runGitCredentialHelper } from './git'
import { resolveHarness } from './harness/harness'
import { kortixEventBus } from './kortix-event-bus'
import { enableDaemonLogFile, logger } from './logger'
import { runMonitorMode } from './monitor-mode'
import { startStaticWebServer } from './static-web'

async function main() {
  const bootTime = Date.now()
  const cfg = loadConfig()
  const selected = resolveHarness(cfg)
  const bootState = selected.createBootState()
  // Publish boot phases through the same sequenced stream as runtime frames.
  const bootMark = (label: string) => {
    const atMs = Date.now() - bootTime
    bootState.timeline.push({ label, atMs })
    kortixEventBus().publishDaemon('kortix.boot', { label, at_ms: atMs })
  }
  const daemonLog = enableDaemonLogFile()
  logger.info('[boot] kortix-sandbox-agent-server starting', {
    servicePort: cfg.servicePort,
    ...selected.bootDetails(cfg),
    staticPort: cfg.staticPort,
    autoClone: cfg.autoClone,
    pid: process.pid,
    bun: typeof Bun !== 'undefined' ? Bun.version : null,
    daemonLogFile: daemonLog.path,
  })

  // Static previews stay available while the repository and runtime boot.
  const staticWeb = startStaticWebServer(cfg.staticPort)
  bootMark('static-web')
  const context = { cfg, bootTime, bootState, bootMark, staticWeb }

  // Warm-seed capture has always taken precedence over monitor selection.
  if (await selected.runWarmSeed?.(context)) return
  if (cfg.workload === 'monitor') {
    await runMonitorMode(context, selected)
    return
  }
  await selected.run(context)
}

// Subcommand dispatch. The compiled binary is reused as a git credential
// helper (`kortix-agent git-credential get`) — git execs it when it needs a
// push/clone credential for the managed remote. Detect that mode before the
// daemon boot path so we don't start a runtime/proxy just to print a token.
const subcommand = process.argv[2]
if (import.meta.main) {
  if (subcommand === 'git-credential') {
    runGitCredentialHelper(loadConfig(), process.argv[3])
      .then((code) => process.exit(code))
      .catch(() => process.exit(0))
  } else if (subcommand === 'install-compiled-runtime') {
    const cfg = loadConfig()
    resolveHarness(cfg).installCompiledRuntime(cfg)
      .then((result) => {
        process.stdout.write(`${result.path}\n`)
        process.exit(0)
      })
      .catch((error) => {
        process.stderr.write(
          `[compiled-runtime] install failed: ${error instanceof Error ? error.message : String(error)}\n`,
        )
        process.exit(1)
      })
  } else if (isManagementSubcommand(subcommand)) {
    // kortixd management CLI: version / install / update / rollback /
    // --health-check / --help. `serve` and any unrecognized verb fall through
    // to the daemon below. See src/cli.ts.
    dispatchCli(process.argv.slice(2))
      .then((outcome) => {
        if (outcome.action === 'exit') process.exit(outcome.code)
        // action === 'serve' cannot happen here (management verbs never serve),
        // but boot the daemon defensively rather than exit silently.
        main().catch((err) => {
          logger.error('[boot] fatal', err)
          process.exit(1)
        })
      })
      .catch((err) => {
        process.stderr.write(`[kortixd] ${err instanceof Error ? err.message : String(err)}\n`)
        process.exit(1)
      })
  } else {
    main().catch((err) => {
      logger.error('[boot] fatal', err)
      process.exit(1)
    })
  }
}
