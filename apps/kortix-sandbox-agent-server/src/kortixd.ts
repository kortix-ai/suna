#!/usr/bin/env bun
import { loadConfig, resolveOpencodeConfigDir } from './config'
import { runGitCredentialHelper } from './git'
import { runKortixDaemon } from './main'
import { ENV_CONTRACT } from './node/env-contract'
import { reconcileRuntimeAssets, runtimeConvergenceReport } from './runtime-assets'
import { clearStoredNodeConfig, readStoredNodeConfig, writeStoredNodeConfig } from './node/config-store'
import { controlService, getServiceStatus, installService, readServiceLogs, uninstallService } from './node/service'
import { superviseKortixd } from './node/supervisor'
import { nodeRuntimePaths } from './node/convergence'
import { openNodeAuthorization, pollNodeDeviceAuth, requestNodeDeviceAuth } from './node/device-auth'

const VERSION = process.env.KORTIXD_VERSION ?? 'dev'

const HELP = `Usage: kortixd <command>

Run and manage a Kortix compute node.

Commands:
  run       Run the node daemon in the foreground
  connect   Enroll this computer as a Kortix compute node
  status    Read the local node health endpoint
  update    Reconcile node runtime components with the configured Kortix API
  doctor    Validate the node configuration and required host tools
  logs      Read local background-service logs
  start     Install or start the background service
  stop      Stop the background service
  restart   Restart the background service
  logout    Remove the local node credential
  version   Print the kortixd version
  help      Show this help
`

function option(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name)
  return index >= 0 ? argv[index + 1] : undefined
}

function healthBaseUrl(argv: readonly string[]): string {
  const explicit = option(argv, '--url')
  if (explicit) return explicit.replace(/\/$/, '')
  return `http://127.0.0.1:${process.env.KORTIX_SERVICE_PORT?.trim() || '8000'}`
}

async function runStatus(argv: readonly string[]): Promise<number> {
  const url = `${healthBaseUrl(argv)}/kortix/health`
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5_000) })
    const text = await response.text()
    if (!response.ok) {
      process.stderr.write(`kortixd: ${url} returned ${response.status}\n`)
      return 1
    }
    if (argv.includes('--json')) {
      process.stdout.write(`${JSON.stringify({ daemon: JSON.parse(text), service: getServiceStatus() })}\n`)
      return 0
    }
    const health = JSON.parse(text) as {
      status?: string
      workload?: string
      runtimeReady?: boolean
      runtime?: { build?: number | null; pinned?: boolean; agentSwapPending?: boolean }
    }
    process.stdout.write(`status: ${health.status ?? 'unknown'}\n`)
    process.stdout.write(`workload: ${health.workload ?? 'unknown'}\n`)
    process.stdout.write(`ready: ${health.runtimeReady === true ? 'yes' : 'no'}\n`)
    process.stdout.write(`runtime build: ${health.runtime?.build ?? 'not converged'}\n`)
    process.stdout.write(`update pinned: ${health.runtime?.pinned === true ? 'yes' : 'no'}\n`)
    process.stdout.write(`swap pending: ${health.runtime?.agentSwapPending === true ? 'yes' : 'no'}\n`)
    return 0
  } catch (error) {
    const service = getServiceStatus()
    if (argv.includes('--json')) {
      process.stdout.write(`${JSON.stringify({ daemon: { status: 'offline', reachable: false }, service })}\n`)
      return 0
    }
    process.stderr.write(
      `kortixd: node is not reachable at ${url}: ${error instanceof Error ? error.message : String(error)}\n`,
    )
    return 1
  }
}

async function runUpdate(): Promise<number> {
  const cfg = loadConfig()
  const configDir = await resolveOpencodeConfigDir(cfg).catch(() => undefined)
  const stored = readStoredNodeConfig()
  const paths = nodeRuntimePaths()
  const result = await reconcileRuntimeAssets(stored ? {
    configDir, apiUrl: stored.api_url, token: stored.credential,
    cliPath: paths.cliPath, managedSkillsDir: paths.managedSkillsDir,
    statePath: paths.statePath, agentStateDir: paths.runtime,
    agentBakedPath: process.execPath, runningAgentPath: process.execPath,
    manifestSigningPublicKey: stored.artifact_signing_public_key,
  } : { configDir })
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  return Object.values(result).includes('failed') ? 1 : 0
}

async function runConnect(argv: readonly string[]): Promise<number> {
  const apiUrl = option(argv, '--api')?.replace(/\/+$/, '')
  let enrollmentToken = option(argv, '--token')
  let signingPublicKey: string | undefined
  if (!apiUrl) {
    process.stderr.write('kortixd: connect requires --api <url>\n')
    return 2
  }
  if (!enrollmentToken) {
    const challenge = await requestNodeDeviceAuth(apiUrl)
    process.stdout.write(`authorize this compute node: ${challenge.verification_url}\n`)
    process.stdout.write(`device code: ${challenge.device_code}\n`)
    if (!argv.includes('--no-browser')) openNodeAuthorization(challenge.verification_url)
    const approved = await pollNodeDeviceAuth(apiUrl, challenge)
    enrollmentToken = approved.enrollmentToken
    signingPublicKey = approved.signingPublicKey
  }
  const response = await fetch(`${apiUrl}/nodes/enroll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enrollment_token: enrollmentToken }),
    signal: AbortSignal.timeout(15_000),
  })
  const result = await response.json().catch(() => null) as { compute_node_id?: string; credential?: string; artifact_signing_public_key?: string | null; error?: string } | null
  if (!response.ok || !result?.compute_node_id || !result.credential) {
    process.stderr.write(`kortixd: enrollment failed (${response.status}): ${result?.error ?? 'invalid response'}\n`)
    return 1
  }
  const path = writeStoredNodeConfig({ api_url: apiUrl, compute_node_id: result.compute_node_id, credential: result.credential, ...(result.artifact_signing_public_key || signingPublicKey ? { artifact_signing_public_key: result.artifact_signing_public_key ?? signingPublicKey } : {}) })
  process.stdout.write(`enrolled compute node ${result.compute_node_id}\n`)
  process.stdout.write(`credential stored at ${path}\n`)
  if (!argv.includes('--no-service')) {
    const service = installService()
    process.stdout.write(`background service: ${service.active ? 'running' : 'installed'}\n`)
  }
  return 0
}

async function runDoctor(): Promise<number> {
  const problems: string[] = []
  for (const executable of ['git', 'bash']) {
    if (Bun.which(executable) === null) problems.push(`required executable not found: ${executable}`)
  }

  let cfg: ReturnType<typeof loadConfig>
  try {
    cfg = loadConfig()
  } catch (error) {
    process.stderr.write(`kortixd: invalid configuration: ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
  if (!cfg.apiUrl) problems.push('KORTIX_API_URL is not set; enrollment and updates are unavailable')
  if (!cfg.nodeToken) {
    problems.push('KORTIX_NODE_TOKEN or an enrolled node credential is required for node control')
  }

  const configured = ENV_CONTRACT.filter(({ name }) => process.env[name] !== undefined).length
  const convergence = await runtimeConvergenceReport()
  process.stdout.write(`declared config keys: ${ENV_CONTRACT.length}\n`)
  process.stdout.write(`configured keys: ${configured}\n`)
  process.stdout.write(`runtime build: ${convergence.build ?? 'not converged'}\n`)
  if (problems.length === 0) {
    process.stdout.write('node configuration: ok\n')
    return 0
  }
  for (const problem of problems) process.stderr.write(`- ${problem}\n`)
  return 1
}

export async function runKortixd(argv: string[]): Promise<number> {
  const command = argv[0] ?? 'help'
  if (command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(HELP)
    return 0
  }
  if (command === 'version' || command === '--version' || command === '-v') {
    process.stdout.write(`kortixd ${VERSION}\n`)
    return 0
  }
  if (command === 'run' || command === 'serve') {
    await runKortixDaemon()
    return 0
  }
  if (command === 'supervise') return superviseKortixd()
  if (command === 'connect') return runConnect(argv.slice(1))
  if (command === 'status') return runStatus(argv.slice(1))
  if (command === 'update') return runUpdate()
  if (command === 'doctor') return runDoctor()
  if (command === 'logs') {
    const lines = Number(option(argv.slice(1), '--lines') ?? '100')
    process.stdout.write(`${readServiceLogs(Number.isFinite(lines) ? lines : 100)}\n`)
    return 0
  }
  if (command === 'start' || command === 'stop' || command === 'restart') {
    const service = controlService(command)
    process.stdout.write(`${JSON.stringify(service)}\n`)
    return 0
  }
  if (command === 'logout') {
    const stored = (() => {
      try { return readStoredNodeConfig() } catch { return null }
    })()
    uninstallService()
    if (stored) {
      await fetch(`${stored.api_url.replace(/\/+$/, '')}/nodes/logout`, {
        method: 'POST',
        headers: { authorization: `Bearer ${stored.credential}`, 'content-type': 'application/json' },
        body: JSON.stringify({ compute_node_id: stored.compute_node_id }),
        signal: AbortSignal.timeout(10_000),
      }).catch(() => null)
    }
    const existed = clearStoredNodeConfig()
    process.stdout.write(existed ? 'local node credential removed\n' : 'no local node credential found\n')
    return 0
  }
  // Permanent compatibility protocol for Git helpers written by old daemon
  // builds. It emits machine-readable key/value output only.
  if (command === 'git-credential') return runGitCredentialHelper(loadConfig(), argv[1])
  process.stderr.write(`kortixd: unknown command \`${command}\`\n${HELP}`)
  return 2
}

if (import.meta.main) {
  runKortixd(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code
    })
    .catch((error) => {
      process.stderr.write(`kortixd: ${error instanceof Error ? error.message : String(error)}\n`)
      process.exitCode = 1
    })
}
