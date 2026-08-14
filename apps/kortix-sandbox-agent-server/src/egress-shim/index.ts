/**
 * Starting, trusting and advertising the in-guest egress shim.
 *
 * Three jobs, in order:
 *   1. decide whether this session gets a shim at all (most do not)
 *   2. mint a CA, start the listener, make the guest trust the CA
 *   3. hand back the env vars that point the agent's clients at it
 *
 * See ./shim.ts for the architecture and ./rules.ts for where the rules and the
 * credential come from.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import type http from 'node:http'
import { dirname } from 'node:path'

import { logger } from '../logger'
import { createEphemeralCa } from './ca'
import { createEgressShim } from './shim'
import { resolveShimConfig, shimUnavailableReason } from './rules'

/** Loopback only. Follows the daemon's `4319`/`4320` proxy convention. */
const DEFAULT_SHIM_PORT = 4321
const CA_DIR = '/tmp/kortix'
/**
 * The bundle handed to clients: the SYSTEM roots with our CA appended.
 *
 * Not our CA on its own. `SSL_CERT_FILE`, `CURL_CA_BUNDLE` and
 * `REQUESTS_CA_BUNDLE` REPLACE the default trust store rather than adding to
 * it, so pointing them at a single-cert file makes the guest trust our CA and
 * nothing else — every ordinary HTTPS call to a host with no rule then fails
 * verification. The shim would look like it had broken the internet.
 */
const CA_BUNDLE_PATH = `${CA_DIR}/egress-ca-bundle.pem`
/** Our CA alone, for `NODE_EXTRA_CA_CERTS`, which ADDS rather than replaces. */
const CA_ONLY_PATH = `${CA_DIR}/egress-ca.pem`

/** Where Debian-family images keep the concatenated system roots. */
const SYSTEM_BUNDLES = [
  '/etc/ssl/certs/ca-certificates.crt',
  '/etc/pki/tls/certs/ca-bundle.crt',
]

export interface StartedEgressShim {
  readonly port: number
  readonly caPath: string
  readonly caBundlePath: string
  readonly fingerprint: string
  /** Hosts the shim terminates. Everything else tunnels blind. */
  readonly hosts: readonly string[]
  /** Env for the AGENT's clients — see {@link egressShimAgentEnv}. */
  readonly env: Readonly<Record<string, string>>
  stop(): void
}

function atomicWrite(path: string, contents: string, mode: number): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o755 })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, contents, { encoding: 'utf8', mode })
  renameSync(tmp, path)
}

/** System roots + our CA, so adding trust never subtracts any. */
function writeTrustBundle(certPem: string): void {
  let system = ''
  for (const candidate of SYSTEM_BUNDLES) {
    if (!existsSync(candidate)) continue
    try {
      system = readFileSync(candidate, 'utf8')
      break
    } catch {
      // Unreadable is the same as absent for our purposes; keep looking.
    }
  }
  if (!system) {
    // Better to ship our CA alone than nothing, but say so loudly: on this
    // image the replace-semantics vars will narrow trust to our CA only.
    logger.warn('[egress-shim] no system CA bundle found; trust bundle holds only the shim CA', {
      looked: SYSTEM_BUNDLES,
    })
  }
  const joined = system ? `${system.trimEnd()}\n${certPem.trimEnd()}\n` : certPem
  // World-readable on purpose: every client the agent runs has to read it.
  atomicWrite(CA_BUNDLE_PATH, joined, 0o644)
  atomicWrite(CA_ONLY_PATH, certPem, 0o644)
}

/**
 * Add the CA to the OS store as well, best effort.
 *
 * The env vars below already cover every runtime we measured, so this is
 * belt-and-braces for a client that reads neither. It needs root and the
 * Debian helper; a failure is logged and ignored rather than fatal.
 */
function installSystemTrust(certPem: string): boolean {
  const target = '/usr/local/share/ca-certificates/kortix-egress.crt'
  try {
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, certPem, { encoding: 'utf8', mode: 0o644 })
    const result = spawnSync('update-ca-certificates', [], { stdio: 'ignore', timeout: 30_000 })
    return result.status === 0
  } catch {
    return false
  }
}

/**
 * The env an agent's clients need. Measured per runtime — see
 * docs/NETWORK_BOUNDARY_ON_DAYTONA.md §7.6, which found the earlier assumption
 * (that this needed an LD_PRELOAD shim) was wrong and a handful of variables is
 * enough.
 *
 *   curl / bun fetch / git   honour `https_proxy` unaided
 *   node fetch (undici)      ignores it WITHOUT `NODE_USE_ENV_PROXY=1`
 *   python requests          honours it, but needs `REQUESTS_CA_BUNDLE`
 *
 * `NO_PROXY` carries the Kortix API host so the in-sandbox CLI and the daemon's
 * own callbacks do not take a pointless extra hop through a proxy that would
 * only tunnel them blind anyway.
 */
export function egressShimAgentEnv(port: number, apiUrl: string): Record<string, string> {
  const proxy = `http://127.0.0.1:${port}`
  let apiHost = ''
  try {
    apiHost = new URL(apiUrl).hostname
  } catch {
    // A malformed KORTIX_API_URL is not worth failing the shim over; the
    // bypass list just loses one entry.
  }
  const noProxy = ['localhost', '127.0.0.1', '::1', apiHost].filter(Boolean).join(',')
  return {
    HTTPS_PROXY: proxy,
    https_proxy: proxy,
    NO_PROXY: noProxy,
    no_proxy: noProxy,
    // ADDS to the default store.
    NODE_EXTRA_CA_CERTS: CA_ONLY_PATH,
    NODE_USE_ENV_PROXY: '1',
    // REPLACE the default store — hence the combined bundle, not CA_ONLY_PATH.
    REQUESTS_CA_BUNDLE: CA_BUNDLE_PATH,
    CURL_CA_BUNDLE: CA_BUNDLE_PATH,
    SSL_CERT_FILE: CA_BUNDLE_PATH,
    GIT_SSL_CAINFO: CA_BUNDLE_PATH,
  }
}

/**
 * The started shim's env, or `{}` when no shim runs.
 *
 * A module-level accessor rather than a value threaded through call sites,
 * because there is exactly ONE shim per daemon and four separate places need
 * its env (the opencode spawn, and three `writeAgentEnvFile` call sites). The
 * threading version had a real failure mode: miss one site and the agent's
 * shells silently lack the proxy, so requests leave uncredentialed and the
 * upstream 401 reads as a bad secret.
 *
 * Empty when no shim runs, so every consumer can spread it unconditionally.
 */
let started: StartedEgressShim | null = null

export function egressShimEnv(): Readonly<Record<string, string>> {
  return started?.env ?? {}
}

/**
 * The port the shim uses, whether or not one is running.
 *
 * The proxy blocklists are built ONCE at daemon startup, before the shim may
 * exist (the fork-adoption path starts it much later). So this reports the
 * configured port rather than a live one — a blocklist that depended on
 * start order would leave the port routable exactly when a fork adopts a
 * session, which is the case hardest to notice.
 */
export function egressShimPort(env: NodeJS.ProcessEnv = process.env): number {
  return Number(env.KORTIX_EGRESS_SHIM_PORT) || DEFAULT_SHIM_PORT
}

/** Test seam: reset the module singleton. */
export function __resetEgressShimForTests(): void {
  started = null
}

/** Stop the listener and drop the in-memory CA key. Safe to call with no shim. */
export function stopEgressShim(): void {
  started?.stop()
}

/**
 * Start the shim for this session, or return null when it does not get one.
 *
 * Null is the ordinary outcome: a session with no network-boundary secret has
 * nothing to relay, and standing up a TLS-terminating proxy for it would be
 * pure risk. A session that WANTED one but cannot have it is logged with the
 * missing piece named — see `shimUnavailableReason`, because a silent no-shim
 * surfaces later as an upstream 401 that looks like a bad credential.
 */
export async function startEgressShim(
  env: NodeJS.ProcessEnv = process.env,
): Promise<StartedEgressShim | null> {
  const config = resolveShimConfig(env)
  if (!config) {
    const reason = shimUnavailableReason(env)
    if (reason) {
      logger.error('[egress-shim] this session has network-boundary secrets but cannot relay', {
        reason,
        consequence: 'requests will leave without the credential and the upstream will reject them',
      })
    }
    return null
  }

  const port = egressShimPort(env)
  const hosts = [...new Set(config.rules.flatMap((rule) => rule.hosts))]
  const ca = createEphemeralCa(env.KORTIX_PROJECT_ID?.slice(0, 8) ?? 'sandbox')

  writeTrustBundle(ca.certPem)
  const systemTrust = installSystemTrust(ca.certPem)

  const server = await createEgressShim({
    ca,
    rules: config.rules,
    apiUrl: config.apiUrl,
    projectId: config.projectId,
    token: config.token,
    onError: (where, err) => logger.warn('[egress-shim] error', { where, error: err.message }),
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    // Loopback ONLY. The decrypted leg must never be reachable from outside
    // this container, and binding to one interface is also why the shim needs
    // no proxy authentication: it serves exactly one sandbox, so there is no
    // second tenant to tell apart. (The API-side ancestor DID authenticate, and
    // its 407 challenge is what broke `git` until the response framing was
    // fixed — a bug class this design does not have.)
    server.listen(port, '127.0.0.1', () => resolve())
  })

  logger.info('[egress-shim] listening', {
    port,
    hosts,
    identifiers: config.rules.map((rule) => rule.identifier),
    caFingerprint: ca.fingerprint.slice(0, 16),
    caNotAfter: ca.notAfter.toISOString(),
    systemTrust,
  })

  started = {
    port,
    caPath: CA_ONLY_PATH,
    caBundlePath: CA_BUNDLE_PATH,
    fingerprint: ca.fingerprint,
    hosts,
    env: egressShimAgentEnv(port, config.apiUrl),
    stop: () => {
      started = null
      try {
        ;(server as http.Server).close()
      } catch {
        // Shutdown races are not worth a stack trace.
      }
    },
  }
  return started
}
