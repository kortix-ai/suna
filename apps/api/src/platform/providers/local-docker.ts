/**
 * Local Docker sandbox provider.
 *
 * Spins the same image used in cloud (apps/sandbox/Dockerfile) as a local
 * container, one container per session. Self-host path: the dev / on-prem
 * operator runs the platform without depending on Daytona Cloud.
 *
 * No bind-mounts. No s6. The image is fully self-contained: it embeds the
 * compiled kortix-agent daemon and the OpenCode CLI. The container exposes
 * port 8000 (the agent) on a random host port; the API proxy reads that
 * port from `resolveEndpoint`.
 *
 * Auto-cleanup: containers are launched with --rm so they vanish on stop.
 * Labels: kortix.session_id=<sandbox_id> for human/`docker ps` triage.
 *
 * Future-proof shape: the brief reserves `docker_sbx` for Docker Inc.'s new
 * managed sandbox product (https://docs.docker.com/ai/sandboxes/). This file
 * does NOT claim that name — only the local-docker-daemon path lives here.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { SANDBOX_VERSION } from '../../config';
import type {
  SandboxProvider,
  ProviderName,
  CreateSandboxOpts,
  ProvisionResult,
  SandboxStatus,
  ResolvedEndpoint,
  ProvisioningTraits,
  ProvisioningStatus,
} from './index';

const execFileAsync = promisify(execFile);

const AGENT_PORT = 8000;
const DEFAULT_IMAGE = 'kortix/sandbox:dev';

function dockerEnv(): NodeJS.ProcessEnv {
  // Honour DOCKER_HOST if set; otherwise rely on the system default socket
  // (works out-of-the-box on macOS Docker Desktop and standard Linux installs).
  return process.env.DOCKER_HOST
    ? { ...process.env, DOCKER_HOST: process.env.DOCKER_HOST }
    : process.env;
}

export function localDockerBaseUrlForPort(port: number): string {
  const host = (process.env.KORTIX_LOCAL_DOCKER_HOST || '127.0.0.1')
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '');
  return `http://${host || '127.0.0.1'}:${port}`;
}

async function runDocker(args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('docker', args, {
      env: dockerEnv(),
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (err: any) {
    const stderr = (err.stderr || '').toString().trim();
    const stdout = (err.stdout || '').toString().trim();
    const detail = stderr || stdout || err.message;
    throw new Error(`docker ${args[0]} failed: ${detail}`);
  }
}

function containerNameFor(slug: string): string {
  return `kortix-session-${slug}`;
}

function flattenEnvVars(envVars: Record<string, string> | undefined): string[] {
  if (!envVars) return [];
  const args: string[] = [];
  for (const [key, value] of Object.entries(envVars)) {
    if (value === undefined || value === null) continue;
    args.push('-e', `${key}=${String(value)}`);
  }
  return args;
}

async function readPublishedPort(containerId: string): Promise<number | null> {
  // docker inspect returns a structured JSON HostPort lookup. Use --format so
  // we can parse without pulling the whole inspect blob into memory.
  const format = `{{ (index (index .NetworkSettings.Ports "${AGENT_PORT}/tcp") 0).HostPort }}`;
  try {
    const raw = await runDocker(['inspect', '--format', format, containerId]);
    const port = parseInt(raw.trim(), 10);
    return Number.isFinite(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

export class LocalDockerProvider implements SandboxProvider {
  readonly name: ProviderName = 'local_docker';

  readonly provisioning: ProvisioningTraits = {
    async: false,
    stages: [
      { id: 'docker_pull', progress: 20, message: 'Pulling sandbox image' },
      { id: 'docker_run', progress: 60, message: 'Starting container' },
      { id: 'opencode_boot', progress: 90, message: 'Booting OpenCode' },
    ],
  };

  async getProvisioningStatus(): Promise<ProvisioningStatus | null> {
    // Sync provider — provisionSessionSandbox flips status to 'active' on its
    // own once create() returns. No staged updates needed.
    return null;
  }

  private resolveImage(): string {
    return process.env.KORTIX_LOCAL_DOCKER_IMAGE || DEFAULT_IMAGE;
  }

  async create(opts: CreateSandboxOpts): Promise<ProvisionResult> {
    const image = this.resolveImage();
    // Use a stable container name keyed off the supplied session slug. The
    // caller (session-sandbox.ts) sets opts.name = "session-<8 hex chars>" so
    // we prefix with the account fragment to avoid collisions across accounts
    // sharing the same docker daemon.
    const slug = opts.accountId
      ? `${opts.accountId.slice(0, 8)}-${opts.name}`
      : opts.name;
    const containerName = containerNameFor(slug);

    const envArgs = flattenEnvVars(opts.envVars);

    // -p 0:8000 → docker picks a free host port; we read it back via inspect.
    // --rm so the container disappears once stopped; we hold its id in the DB
    // row so getStatus correctly reports `removed` after exit.
    const runArgs = [
      'run',
      '-d',
      '--rm',
      '--name', containerName,
      '--label', `kortix.session_id=${opts.name}`,
      '--label', `kortix.account_id=${opts.accountId}`,
      '-p', `0:${AGENT_PORT}`,
      ...envArgs,
      image,
    ];

    const containerId = (await runDocker(runArgs)).trim();
    if (!containerId) {
      throw new Error('docker run returned empty container id');
    }

    // Read back the host port that docker chose.
    const hostPort = await readPublishedPort(containerId);
    if (!hostPort) {
      // The container is running but we couldn't find the published port —
      // best-effort cleanup, then bail. The caller will mark the row errored.
      try { await runDocker(['rm', '-f', containerId]); } catch {}
      throw new Error(`docker inspect did not return a host port for container ${containerId}`);
    }

    const baseUrl = localDockerBaseUrlForPort(hostPort);

    return {
      externalId: containerId,
      baseUrl,
      metadata: {
        provisionedBy: opts.userId,
        containerName,
        hostPort,
        image,
        version: SANDBOX_VERSION,
      },
    };
  }

  async start(externalId: string): Promise<void> {
    // --rm containers can't be restarted once exited; this is a best-effort
    // re-start for containers launched without --rm in the past or by the
    // user. Failure here is non-fatal; ensureRunning will surface it.
    await runDocker(['start', externalId]);
  }

  async stop(externalId: string): Promise<void> {
    await runDocker(['stop', externalId]);
  }

  async remove(externalId: string): Promise<void> {
    await runDocker(['rm', '-f', externalId]);
  }

  async getStatus(externalId: string): Promise<SandboxStatus> {
    try {
      const state = await runDocker([
        'inspect',
        '--format',
        '{{.State.Status}}',
        externalId,
      ]);
      const s = state.toLowerCase();
      if (s === 'running') return 'running';
      if (s === 'exited' || s === 'created' || s === 'dead' || s === 'paused') return 'stopped';
      return 'unknown';
    } catch (err: any) {
      // `docker inspect` exits 1 if the container is gone — that's "removed"
      // from our PoV (--rm cleans up on stop).
      if (/No such (object|container)/.test(err?.message || '')) return 'removed';
      return 'unknown';
    }
  }

  async resolveEndpoint(externalId: string): Promise<ResolvedEndpoint> {
    const port = await readPublishedPort(externalId);
    if (!port) {
      throw new Error(`No published port for local_docker container ${externalId}`);
    }
    return {
      url: localDockerBaseUrlForPort(port),
      headers: {},
    };
  }

  async ensureRunning(externalId: string): Promise<void> {
    const status = await this.getStatus(externalId);
    if (status === 'running') return;
    if (status === 'removed') {
      throw new Error(`local_docker container ${externalId} no longer exists`);
    }
    console.log(`[LOCAL_DOCKER] Container ${externalId} is ${status}, starting...`);
    await this.start(externalId);
  }
}
