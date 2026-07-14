import { mkdirSync, openSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname } from 'node:path'
import { agentEnvDirIsTmpfs, writeAgentEnvFile } from './agent-env-file'
import { loadConfig, resolveSandboxOnBoot } from './config'
import {
  configureGitCredentialHelper,
  configureGlobalGitIdentity,
  configureRepoCredentialHelper,
  materializeRepo,
  runGitCredentialHelper,
} from './git'
import { logger } from './logger'
import { createProjectEnvStore } from './project-env'
import { startProxy } from './proxy'
import type { SandboxBootState } from './routes/health'
import { installShutdownHandlers } from './shutdown'
import { startStaticWebServer } from './static-web'
import { createAcpHarnessRegistry, nativeConfigDir, parseAcpHarnessId } from './acp/harness-registry'
import { AcpRuntime } from './acp/runtime'
import { ensureInjectedManagedSkills } from './injected-skills'

async function main() {
  const bootTime = Date.now()
  const cfg = loadConfig()
  const harness = parseAcpHarnessId(process.env.KORTIX_RUNTIME_HARNESS)
  const compiledPlan = (process.env.KORTIX_COMPILED_RUNTIME_PLAN ?? '').trim()
  const serverId = (process.env.KORTIX_SESSION_ID ?? '').trim()
  const bootState: SandboxBootState = {
    repoMaterializationError: null,
    timeline: [],
    acpHarness: harness,
    acpServerId: serverId || null,
    acpRuntimeReady: false,
    acpRuntimeError: null,
  }
  const mark = (label: string) => bootState.timeline.push({ label, atMs: Date.now() - bootTime })

  logger.info('[boot] ACP sandbox daemon starting', { servicePort: cfg.servicePort, harness })
  const staticWeb = startStaticWebServer(cfg.staticPort)
  mark('static-web')

  await configureGlobalGitIdentity(cfg, process.env.HOME || '/root').catch((error) =>
    logger.warn('[boot] git identity setup failed', { error: error instanceof Error ? error.message : String(error) }),
  )
  await configureGitCredentialHelper(cfg, process.env.HOME || '/root').catch((error) =>
    logger.warn('[boot] git credential helper setup failed', { error: error instanceof Error ? error.message : String(error) }),
  )

  const projectEnv = createProjectEnvStore()
  if (!agentEnvDirIsTmpfs()) logger.error('[boot] agent environment directory is not tmpfs')
  if (!writeAgentEnvFile(projectEnv)) logger.error('[boot] failed to write agent environment file')

  if (cfg.autoClone) {
    await materializeRepo(cfg).catch((error) => {
      bootState.repoMaterializationError = error instanceof Error ? error.message : String(error)
      logger.error('[boot] repo materialization failed', error)
    })
  }
  mark('repo-materialized')
  if (!bootState.repoMaterializationError) {
    await configureRepoCredentialHelper(cfg, cfg.projectTarget).catch((error) =>
      logger.warn('[boot] repo credential helper setup failed', { error: error instanceof Error ? error.message : String(error) }),
    )
    // Overlay the always-latest managed Kortix skills (kortix-cli + kortix-*)
    // into the runtime's config dir so no project goes stale on Kortix
    // internals, whatever the repo committed. Never throws.
    const runtimeConfigDir = nativeConfigDir(process.env)
    if (runtimeConfigDir) await ensureInjectedManagedSkills(runtimeConfigDir)
  }

  const runtime = new AcpRuntime({ registry: createAcpHarnessRegistry(), cwd: cfg.projectTarget, projectEnv })
  if (!bootState.repoMaterializationError) {
    if (!harness || !compiledPlan || !serverId) {
      bootState.acpRuntimeError = 'compiled ACP runtime is missing a session id, harness, or runtime plan'
    } else {
      try {
        await runtime.getOrCreate(serverId, harness)
        bootState.acpRuntimeReady = true
        mark('acp-process-spawned')
      } catch (error) {
        bootState.acpRuntimeError = error instanceof Error ? error.message : String(error)
        logger.error('[boot] ACP runtime process failed', error)
      }
    }
  }

  const proxy = startProxy(cfg, bootTime, bootState, projectEnv, staticWeb.port, runtime)
  installShutdownHandlers(proxy, staticWeb)
  mark('proxy-up')

  if (!bootState.repoMaterializationError) {
    void resolveSandboxOnBoot(cfg).then((command) => {
      if (!command) return
      const logPath = '/var/log/kortix-on-boot.log'
      try { mkdirSync(dirname(logPath), { recursive: true }) } catch {}
      const output = openSync(logPath, 'a')
      const child = spawn('bash', ['-lc', command], {
        cwd: cfg.projectTarget,
        env: process.env,
        detached: true,
        stdio: ['ignore', output, output],
      })
      child.on('error', (error) => logger.warn('[boot] on_boot command failed', { error: error.message }))
      child.unref()
    }).catch((error) => logger.warn('[boot] on_boot resolution failed', { error: error instanceof Error ? error.message : String(error) }))
  }
}

const subcommand = process.argv[2]
if (import.meta.main) {
  if (subcommand === 'git-credential') {
    runGitCredentialHelper(loadConfig(), process.argv[3])
      .then((code) => process.exit(code))
      .catch(() => process.exit(0))
  } else {
    main().catch((error) => {
      logger.error('[boot] fatal', error)
      process.exit(1)
    })
  }
}
