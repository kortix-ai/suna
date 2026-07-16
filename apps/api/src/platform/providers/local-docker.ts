/**
 * Local Docker sandbox provider — EXPERIMENTAL.
 *
 * Runs project sandboxes as plain Docker containers on THIS machine — the
 * same host running kortix-api — via the local Docker Engine socket. There is
 * no cloud account, no multi-node scheduling, no remote API: `create()` is a
 * `docker run`, `stop()`/`start()` are `docker stop`/`docker start` (the
 * container's writable layer is the persistence — nothing is deleted until
 * `remove()`), and `getStatus()` is a `docker inspect`.
 *
 * Scope, by design: this is a single-machine provider (see the PR description
 * for the full non-goals list — no Swarm, no multi-node, no per-container
 * disk quotas in v1). It implements the exact same `SandboxProvider` contract
 * as Daytona/Platinum/E2B — nothing outside this file knows local-docker
 * exists (see provider-boundary.test.ts). Any behavior that looks like it
 * needs a `provider === 'local-docker'` branch elsewhere belongs HERE instead.
 */

import Docker from 'dockerode';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { config, SANDBOX_VERSION } from '../../config';
import { resolveLlmGatewayBaseUrl } from '../../llm-gateway/sandbox-base-url';
import { serviceKeyForExternalId } from '../service-key';
import { sandboxFrontendBaseUrl } from '../sandbox-frontend-url';
import type {
  SandboxProvider,
  ProviderName,
  CreateSandboxOpts,
  ProvisionResult,
  SandboxStatus,
  ResolvedEndpoint,
  ProvisioningTraits,
  ProvisioningStatus,
  ResolvedSandboxIngress,
  SandboxIngressRequest,
} from './index';

/** Agent daemon port every sandbox image EXPOSEs (matches every other provider). */
const AGENT_PORT = 8000;

/** Every managed container is named `kortix-sb-<externalId>` — grep-able, collision-safe. */
const CONTAINER_PREFIX = 'kortix-sb-';

/**
 * Fixed per-container resource ceiling. Daytona/Platinum bake `cpu`/`memoryGb`
 * from the template's spec into the SNAPSHOT itself (see snapshots/providers/
 * daytona.ts + build-context.ts DEFAULT_CPU/DEFAULT_MEMORY_GB) and the running
 * sandbox just inherits it — Docker has no such concept; resource limits are a
 * `docker run` (HostConfig) property, not an image property, and
 * `CreateSandboxOpts` (the shared provider contract) carries no per-template
 * spec today. Rather than thread a new field through every provider for a
 * same-machine-only implementation, apply one configurable ceiling to every
 * local-docker container — same numbers the platform already defaults an
 * unspecified template spec to. A per-template override is a legitimate
 * follow-up (extend CreateSandboxOpts) but is not required for parity: every
 * OTHER provider also falls back to its own default when a template omits a
 * spec.
 */
const DEFAULT_CPUS = Number.parseFloat(process.env.LOCAL_DOCKER_CPUS || '2') || 2;
const DEFAULT_MEMORY_GB = Number.parseFloat(process.env.LOCAL_DOCKER_MEMORY_GB || '6') || 6;

// Labels stamped on every Kortix-managed local-docker container. Mirrors
// daytona.ts's managedSandboxLabels() exactly — the reaper's
// listManagedRunningSandboxes() scoping logic is provider-agnostic and reads
// the SAME two labels regardless of provider.
function managedLabels(externalId: string): Record<string, string> {
  return {
    'kortix.managed': 'true',
    'kortix.env': config.INTERNAL_KORTIX_ENV,
    'kortix.sandbox': externalId,
  };
}

function containerName(externalId: string): string {
  return `${CONTAINER_PREFIX}${externalId}`;
}

/** Resolve the dockerode client options from config (empty = library default). */
function dockerOptions(): ConstructorParameters<typeof Docker>[0] {
  const socketPath = config.LOCAL_DOCKER_SOCKET_PATH?.trim();
  return socketPath ? { socketPath } : {};
}

let dockerClient: Docker | null = null;

/** Lazily-created, memoized dockerode client. Reset only by tests. */
export function getDockerClient(): Docker {
  if (!dockerClient) dockerClient = new Docker(dockerOptions());
  return dockerClient;
}

/**
 * Test-only seam: inject a fake client (unit tests) or reset to force a fresh
 * one next call (live tests). Typed loosely (`unknown`) so unit tests can
 * supply a minimal structural fake instead of a full `Docker` instance.
 */
export function __setDockerClientForTest(client: unknown): void {
  dockerClient = client as Docker | null;
}

/**
 * Best-effort SYNC hint used by config.ts-adjacent readiness checks (never the
 * gate itself — the real check is the async `assertDockerReachable` below,
 * run at first actual provider use). A `unix://` DOCKER_HOST or the resolved
 * default socket path is checked for existence on disk; a `tcp://` DOCKER_HOST
 * can't be checked synchronously and is optimistically assumed present.
 */
export function localDockerSocketLooksPresent(): boolean {
  const explicit = config.LOCAL_DOCKER_SOCKET_PATH?.trim();
  const dockerHost = process.env.DOCKER_HOST?.trim();
  if (dockerHost && /^tcp:\/\//i.test(dockerHost)) return true;
  const path = explicit || dockerHost?.replace(/^unix:\/\//, '') || '/var/run/docker.sock';
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}

/**
 * The one clear, actionable error every local-docker entry point throws when
 * the daemon isn't reachable — "fail at first use" per the provider's design
 * (never at API boot, since self-host must still start with no Docker access
 * so the operator can reach the dashboard to fix it).
 */
async function assertDockerReachable(docker: Docker): Promise<void> {
  try {
    await docker.ping();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `[local-docker] Docker daemon is not reachable (${detail}). The local-docker sandbox ` +
      `provider requires the host's Docker socket mounted into kortix-api (self-host: select ` +
      `"local-docker" at \`kortix self-host init\`, which wires this automatically) — or, ` +
      `outside self-host, set LOCAL_DOCKER_SOCKET_PATH / DOCKER_HOST to a reachable Docker Engine.`,
    );
  }
}

/** Get-or-create the shared network every managed container joins (idempotent). */
async function ensureNetwork(docker: Docker, name: string): Promise<void> {
  try {
    await docker.getNetwork(name).inspect();
  } catch (err) {
    if (!isNotFoundError(err)) throw err;
    try {
      await docker.createNetwork({ Name: name, Driver: 'bridge', CheckDuplicate: true });
    } catch (createErr) {
      // Lost a create race with another process/replica — fine, it exists now.
      if (!isConflictError(createErr)) throw createErr;
    }
  }
}

function isNotFoundError(err: unknown): boolean {
  const status = (err as { statusCode?: unknown } | null | undefined)?.statusCode;
  return status === 404;
}

function isConflictError(err: unknown): boolean {
  const status = (err as { statusCode?: unknown } | null | undefined)?.statusCode;
  return status === 409;
}

/**
 * The internal URL the CONTAINER uses to call back to kortix-api. Sandboxes
 * live on the same Docker network as kortix-api in the supported (self-host)
 * deployment shape, so Docker's own DNS resolves the compose service name —
 * far more reliable than trying to infer a host-reachable URL from KORTIX_URL
 * (which may be a public domain or an ephemeral tunnel neither necessary nor
 * always resolvable from inside a container). `kortix-api` is the fixed
 * Compose service name (see apps/cli/src/self-host/assets/kortix-compose.yml);
 * override via LOCAL_DOCKER_API_HOST for a non-Compose topology.
 */
function sandboxInternalApiBase(): string {
  const host = process.env.LOCAL_DOCKER_API_HOST?.trim() || 'kortix-api';
  const port = process.env.LOCAL_DOCKER_API_PORT?.trim() || String(config.PORT || 8008);
  return `http://${host}:${port}`;
}

function isMissingContainerError(err: unknown): boolean {
  const status = (err as { statusCode?: unknown } | null | undefined)?.statusCode;
  return status === 404;
}

function toStatus(info: Docker.ContainerInspectInfo): SandboxStatus {
  const state = info.State;
  if (state?.Running) return 'running';
  if (state?.Status === 'exited' || state?.Status === 'created' || state?.Status === 'dead') return 'stopped';
  return 'unknown';
}

export class LocalDockerProvider implements SandboxProvider {
  readonly name: ProviderName = 'local-docker';
  // Sandboxes are containers on the SAME machine, reached over the shared
  // Docker network — never over the public internet. A loopback KORTIX_URL is
  // exactly right here, so the generic reachability preflight in
  // projects/lib/sessions.ts skips its "cloud sandbox can't call back to
  // localhost" check for this provider (see the interface doc on this field).
  readonly requiresPublicCallback = false;

  readonly provisioning: ProvisioningTraits = {
    async: false,
    stages: [
      { id: 'creating', progress: 50, message: 'Starting local container...' },
    ],
  };

  /**
   * See the interface doc: this is the ONE provider that overrides it. A
   * local-docker sandbox shares a private Docker network with kortix-api
   * (never the public internet), so anything built from "the API's public
   * origin" — e.g. the LLM-gateway base URL — must be rebuilt on this address
   * instead, exactly like KORTIX_API_URL already is in create() below.
   */
  sandboxFacingApiOrigin(): string {
    return sandboxInternalApiBase();
  }

  async getProvisioningStatus(): Promise<ProvisioningStatus | null> {
    return null;
  }

  async create(opts: CreateSandboxOpts): Promise<ProvisionResult> {
    // Every sandbox boots from its project's own per-project snapshot — the
    // SAME per-provider Docker image the local-docker snapshot adapter built
    // (apps/api/src/snapshots/providers/local-docker.ts). No shared fallback,
    // matching Daytona's contract exactly (see daytona.ts's identical guard).
    const snapshot = opts.snapshot;
    if (!snapshot) {
      throw new Error(
        'local-docker create() called without opts.snapshot. Every sandbox must boot from a ' +
        'per-project image built by apps/api/src/snapshots/builder.ts. There is no shared fallback.',
      );
    }
    if (!opts.envVars?.KORTIX_SANDBOX_TOKEN) {
      throw new Error('[local-docker] create() called without KORTIX_SANDBOX_TOKEN — sandbox cannot authenticate to the Kortix router.');
    }

    const docker = getDockerClient();
    await assertDockerReachable(docker);

    const network = config.LOCAL_DOCKER_NETWORK || 'kortix-local-docker';
    await ensureNetwork(docker, network);

    const externalId = randomUUID();
    const name = containerName(externalId);

    // KORTIX_API_URL/KORTIX_FRONTEND_URL are computed here (Docker-network DNS,
    // not the generic public KORTIX_URL every OTHER provider is happy to reuse
    // verbatim) and MUST win over whatever the generic session env-builder
    // put in `opts.envVars` (buildSessionRuntimeEnv() unconditionally sets
    // KORTIX_API_URL from config.KORTIX_URL for every provider, since that's
    // the right value for a remote cloud sandbox). Spread opts.envVars FIRST
    // so these two keys are applied on top, not the other way around.
    const envVars: Record<string, string> = {
      ...opts.envVars,
      KORTIX_API_URL: `${sandboxInternalApiBase()}/v1`,
      KORTIX_FRONTEND_URL: sandboxFrontendBaseUrl(),
    };
    // Same fix, same reason, for OpenCode's own LLM-gateway base URL: session-
    // sandbox.ts's provisionSessionSandbox() already asks
    // `provider.sandboxFacingApiOrigin()` for this (see that file), so by the
    // time we get here KORTIX_LLM_BASE_URL in opts.envVars should already be
    // Docker-network-correct — but recompute+override unconditionally anyway,
    // matching KORTIX_API_URL's belt-and-suspenders posture above, so this
    // provider is correct even if a future caller reintroduces the generic
    // public origin (e.g. session-sandbox.ts's provider var got reassigned by
    // a mid-provision failover to/from another provider before this ran).
    // `KORTIX_LLM_BASE_URL` is present at all only when the LLM gateway is
    // enabled + entitled for this session (see session-sandbox.ts) — absent
    // otherwise, so OpenCode falls back to its native provider behavior.
    if (envVars.KORTIX_LLM_BASE_URL) {
      envVars.KORTIX_LLM_BASE_URL = resolveLlmGatewayBaseUrl(sandboxInternalApiBase());
    }
    const env = Object.entries(envVars).map(([k, v]) => `${k}=${v}`);

    const container = await docker.createContainer({
      name,
      Image: snapshot,
      Env: env,
      ExposedPorts: { [`${AGENT_PORT}/tcp`]: {} },
      Labels: managedLabels(externalId),
      HostConfig: {
        NetworkMode: network,
        // Published to loopback only — convenience for operator/CLI debugging
        // and for anything reaching the box from OUTSIDE the Docker network
        // (e.g. a non-containerized `kortix-api` in plain `pnpm dev`). The
        // in-network path (resolveEndpoint/resolveIngress below) never uses
        // this; it always addresses the container by its network DNS name —
        // load-bearing, not just style: an ephemeral `HostPort: '0'` mapping
        // is NOT guaranteed stable across a stop/start cycle (observed
        // reassigning to a new port on Docker Desktop), so anything that
        // depended on this published port surviving a resume would be wrong.
        PortBindings: { [`${AGENT_PORT}/tcp`]: [{ HostIp: '127.0.0.1', HostPort: '0' }] },
        NanoCpus: Math.round(DEFAULT_CPUS * 1e9),
        Memory: Math.round(DEFAULT_MEMORY_GB * 1024 * 1024 * 1024),
        RestartPolicy: { Name: 'unless-stopped' },
        // Docker daemon default networking on Linux lets the host reach an
        // extra_hosts host-gateway; harmless on Docker Desktop where it
        // already resolves. Costs nothing to always set.
        ExtraHosts: ['host.docker.internal:host-gateway'],
      },
    });
    await container.start();

    const baseUrl = `${config.KORTIX_URL.replace(/\/+$/, '')}/v1/p/${externalId}/${AGENT_PORT}`;

    return {
      externalId,
      baseUrl,
      metadata: {
        provisionedBy: opts.userId,
        containerName: name,
        containerId: container.id,
        image: snapshot,
        network,
        version: SANDBOX_VERSION,
      },
    };
  }

  async start(externalId: string): Promise<void> {
    const docker = getDockerClient();
    await assertDockerReachable(docker);
    try {
      await docker.getContainer(containerName(externalId)).start();
    } catch (err) {
      // Docker 304s "already started" — treat as success, matching the
      // idempotent semantics ensureRunning()/callers expect.
      if (!isAlreadyStartedError(err)) throw err;
    }
  }

  async stop(externalId: string): Promise<void> {
    const docker = getDockerClient();
    await assertDockerReachable(docker);
    try {
      // Stop preserves the container (and its writable layer) — this IS the
      // persistence semantics: the workspace, installed deps, shell history,
      // everything survives until an explicit remove().
      await docker.getContainer(containerName(externalId)).stop({ t: 10 });
    } catch (err) {
      if (!isAlreadyStoppedError(err)) throw err;
    }
  }

  async remove(externalId: string): Promise<void> {
    const docker = getDockerClient();
    await assertDockerReachable(docker);
    try {
      await docker.getContainer(containerName(externalId)).remove({ force: true, v: true });
    } catch (err) {
      if (!isMissingContainerError(err)) throw err;
    }
  }

  async getStatus(externalId: string): Promise<SandboxStatus> {
    try {
      const docker = getDockerClient();
      await assertDockerReachable(docker);
      const info = await docker.getContainer(containerName(externalId)).inspect();
      return toStatus(info);
    } catch (err) {
      if (isMissingContainerError(err)) return 'removed';
      return 'unknown';
    }
  }

  async resolveIngress(externalId: string, request: SandboxIngressRequest): Promise<ResolvedSandboxIngress> {
    // Docker's own network DNS makes every port on the container reachable by
    // name with zero pre-registration — no expose/preview-link step needed
    // (unlike Daytona/Platinum, whose edges must be told about a port first).
    return {
      url: `http://${containerName(externalId)}:${request.port}`,
      headers: {},
      effectivePort: request.port,
    };
  }

  routeIngress(request: SandboxIngressRequest) {
    return { effectivePort: request.port };
  }

  async resolveEndpoint(externalId: string): Promise<ResolvedEndpoint> {
    const ingress = await this.resolveIngress(externalId, { port: AGENT_PORT, transport: 'http' });
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    try {
      const serviceKey = await serviceKeyForExternalId(externalId);
      if (serviceKey) headers['Authorization'] = `Bearer ${serviceKey}`;
    } catch (err) {
      console.warn(`[LOCAL-DOCKER] Failed to look up service key for ${externalId}:`, err);
    }
    return { url: ingress.url, headers };
  }

  async ensureRunning(externalId: string): Promise<void> {
    const status = await this.getStatus(externalId);
    if (status === 'running') return;
    if (status === 'stopped') {
      console.log(`[LOCAL-DOCKER] Sandbox ${externalId} is stopped, starting...`);
      await this.start(externalId);
    }
    // 'removed' / 'unknown': nothing this provider can recover in place (no
    // recoverInPlace — see the interface doc: callers fail closed).
  }

  /**
   * List every container this environment manages, for the orphan-box reaper.
   * Scoped by BOTH kortix.managed and kortix.env — mirrors daytona.ts exactly.
   * Unlike the cloud providers, a local Docker daemon is never shared across
   * environments in practice, but scoping identically keeps the reaper's
   * cross-provider logic uniform (and safe if a laptop ever runs two
   * kortix-api instances against the same daemon, e.g. dev + a worktree).
   */
  async listManagedRunningSandboxes(): Promise<Array<{ externalId: string; createdAt: Date | null }>> {
    const docker = getDockerClient();
    await assertDockerReachable(docker);
    const containers = await docker.listContainers({
      all: false,
      filters: JSON.stringify({
        label: ['kortix.managed=true', `kortix.env=${config.INTERNAL_KORTIX_ENV}`],
      }),
    });
    return containers.map((c) => ({
      externalId: c.Labels?.['kortix.sandbox'] || c.Names?.[0]?.replace(/^\//, '').replace(CONTAINER_PREFIX, '') || c.Id,
      createdAt: c.Created ? new Date(c.Created * 1000) : null,
    }));
  }
}

function isAlreadyStartedError(err: unknown): boolean {
  const status = (err as { statusCode?: unknown } | null | undefined)?.statusCode;
  return status === 304;
}

function isAlreadyStoppedError(err: unknown): boolean {
  const status = (err as { statusCode?: unknown } | null | undefined)?.statusCode;
  return status === 304;
}
