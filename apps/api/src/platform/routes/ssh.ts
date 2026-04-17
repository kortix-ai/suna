/**
 * SSH key setup route.
 *
 * Supports multiple providers:
 *   - local_docker: generates ed25519 keypair via ssh-keygen, injects pubkey via docker exec
 *   - justavps: generates ed25519 keypair, injects pubkey into the sandbox container
 *               via host toolbox + docker exec, then routes SSH on port 22 into
 *               the container instead of returning VPS host root access.
 *
 * Mounted at /v1/platform/sandbox/ssh
 *
 * Routes:
 *   POST /setup  → Generate keypair, inject into sandbox container, return private key + ssh command
 */

import { Hono } from 'hono';
import { execSync } from 'child_process';
import { readFileSync, unlinkSync, mkdirSync, rmdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import Docker from 'dockerode';
import { sandboxes } from '@kortix/db';
import { config } from '../../config';
import { execOnHost } from '../../update/exec';
import type { AuthVariables } from '../../types';
import { supabaseAuth } from '../../middleware/auth';
import { db } from '../../shared/db';
import { resolveAccountId } from '../../shared/resolve-account';
import { buildSSHConnectionInfo, buildSSHSetupPayload, resolvePublicSSHHost, type SSHConnectionInfo } from '../services/ssh-access';
import { findAccessibleSandboxForUser } from '../services/sandbox-access';

const sshRouter = new Hono<{ Variables: AuthVariables }>();
sshRouter.use('/*', supabaseAuth);

// ─── Shared: keypair generation ──────────────────────────────────────────────

function generateKeypair(comment = 'kortix-sandbox'): { privateKey: string; publicKey: string } {
  const tmpPath = join(tmpdir(), `kortix-ssh-${Date.now()}`);
  mkdirSync(tmpPath, { recursive: true });
  const keyPath = join(tmpPath, 'key');

  try {
    execSync(`ssh-keygen -t ed25519 -f "${keyPath}" -N "" -C "${comment}" -q`, { stdio: 'pipe' });
  } catch {
    throw new Error('Failed to generate SSH keypair via ssh-keygen');
  }

  const privateKey = readFileSync(keyPath, 'utf-8');
  const publicKey = readFileSync(`${keyPath}.pub`, 'utf-8').trim();

  try { unlinkSync(keyPath); } catch {}
  try { unlinkSync(`${keyPath}.pub`); } catch {}
  try { rmdirSync(tmpPath); } catch {}

  return { privateKey, publicKey };
}

type SandboxRecord = typeof sandboxes.$inferSelect;

async function resolveSandboxRecord(userId: string, requestedSandboxId?: string): Promise<SandboxRecord | null> {
  const { sandbox } = await findAccessibleSandboxForUser({
    db,
    userId,
    sandboxId: requestedSandboxId,
    defaultStatus: requestedSandboxId ? undefined : 'active',
    resolveAccountId,
  });

  return sandbox;
}

// ─── Shared: authorized_keys injection via remote host toolbox exec ──────────
// JustAVPS resolveEndpoint() points at the VPS host toolbox endpoint, not the
// sandbox's kortix-master API. To inject a key into the Dockerized sandbox we
// must exec on the host, then docker exec into the workload container.

async function injectPublicKeyViaHostExec(
  endpoint: { url: string; headers: Record<string, string> },
  publicKey: string,
  containerName = 'justavps-workload',
): Promise<void> {
  const publicKeyB64 = Buffer.from(`${publicKey}\n`).toString('base64');
  const innerCmd = [
    `mkdir -p /config/.ssh`,
    `printf '%s' '${publicKeyB64}' | base64 -d >> /config/.ssh/authorized_keys`,
    `sort -u -o /config/.ssh/authorized_keys /config/.ssh/authorized_keys`,
    `chmod 700 /config/.ssh`,
    `chmod 600 /config/.ssh/authorized_keys`,
    `chown -R abc:abc /config/.ssh`,
  ].join(' && ');
  const escapedInnerCmd = innerCmd.replace(/(["`$\\])/g, '\\$1');
  const hostCmd = `docker exec ${containerName} sh -lc "${escapedInnerCmd}"`;

  const result = await execOnHost(endpoint, hostCmd, 30);
  if (!result.success) {
    throw new Error(`Failed to inject SSH key into sandbox: ${result.stderr || result.stdout || 'unknown host exec error'}`);
  }
}

async function verifyPublicKeyViaHostExec(
  endpoint: { url: string; headers: Record<string, string> },
  publicKey: string,
  containerName = 'justavps-workload',
): Promise<void> {
  const keyData = publicKey.split(' ')[1] || publicKey;
  // Single-quote the sh -lc argument so $(stat ...) is evaluated by the
  // container's shell, not the host. The previous \"...\" quoting broke
  // the host's quoting state, causing the substitutions to run on the
  // host (where /config/.ssh/authorized_keys does not exist) and leading
  // to both "cannot statx" noise and `test: =: unexpected operator` when
  // dash saw the resulting empty LHS. "x$VAR" = "xLIT" tolerates empty
  // substitutions without the =-as-operator error.
  // keyData is the ssh-ed25519 blob (base64 + '/+='), safe inside "...".
  const verifyCmd = `docker exec ${containerName} sh -lc 'test -f /config/.ssh/authorized_keys && grep -qF "${keyData}" /config/.ssh/authorized_keys && [ "x$(stat -c %a /config/.ssh/authorized_keys 2>/dev/null)" = "x600" ] && [ "x$(stat -c %U /config/.ssh/authorized_keys 2>/dev/null)" = "xabc" ]'`;
  const result = await execOnHost(endpoint, verifyCmd, 30);
  if (!result.success) {
    throw new Error(`SSH key verification failed: ${result.stderr || result.stdout || 'authorized_keys missing or invalid'}`);
  }
}

async function injectPublicKeyViaHostExecWithRetry(
  endpoint: { url: string; headers: Record<string, string> },
  publicKey: string,
  timeoutMs = 120_000,
): Promise<void> {
  const startedAt = Date.now();
  let lastError: unknown = null;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      await injectPublicKeyViaHostExec(endpoint, publicKey);
      return;
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('Timed out waiting for sandbox exec endpoint to become ready');
}

function buildAuthorizedKeysInstallCommand(publicKey: string, targetDir: string): string {
  const publicKeyB64 = Buffer.from(`${publicKey}\n`).toString('base64');
  return [
    `mkdir -p ${targetDir}`,
    `printf '%s' '${publicKeyB64}' | base64 -d >> ${targetDir}/authorized_keys`,
    `sort -u -o ${targetDir}/authorized_keys ${targetDir}/authorized_keys`,
    `chmod 700 ${targetDir}`,
    `chmod 600 ${targetDir}/authorized_keys`,
    `chown -R abc:abc ${targetDir}`,
  ].join(' && ');
}

async function verifyAuthorizedKeyInContainer(container: Docker.Container, publicKey: string, targetDir = '/config/.ssh'): Promise<void> {
  const keyData = publicKey.split(' ')[1] || publicKey;
  await runContainerCommand(
    container,
    `test -f ${targetDir}/authorized_keys && grep -q '${keyData}' ${targetDir}/authorized_keys && test "$(stat -c %a ${targetDir}/authorized_keys)" = "600" && test "$(stat -c %U ${targetDir}/authorized_keys)" = "abc"`,
  );
}

function resolveLocalSshPort(sandbox: SandboxRecord | null): number {
  const meta = (sandbox?.metadata || {}) as Record<string, unknown>;
  const mappedPorts = (meta.mappedPorts || {}) as Record<string, string>;
  const mapped = parseInt(mappedPorts['22'] || '', 10);
  return Number.isFinite(mapped) && mapped > 0 ? mapped : config.SANDBOX_PORT_BASE + 7;
}

function buildConnectionForLocalDocker(c: any, sandbox: SandboxRecord | null): SSHConnectionInfo {
  return buildSSHConnectionInfo({
    host: resolvePublicSSHHost(c),
    port: resolveLocalSshPort(sandbox),
    username: 'abc',
    provider: 'local_docker',
  });
}

async function buildConnectionForJustavps(externalId: string): Promise<SSHConnectionInfo> {
  const { justavpsFetch } = await import('../providers/justavps');
  const machine = await justavpsFetch<{ ip: string | null; status: string }>(`/machines/${externalId}`);

  if (machine.status !== 'ready') {
    throw new Error('Sandbox is not ready yet. Wait for provisioning to complete.');
  }

  if (!machine.ip) {
    throw new Error('Sandbox does not have an IP address yet.');
  }

  return buildSSHConnectionInfo({
    host: machine.ip,
    port: 22,
    username: 'abc',
    provider: 'justavps',
  });
}

// ─── Local Docker: inject via docker exec ────────────────────────────────────

function getDockerClient(): Docker {
  if (!config.DOCKER_HOST) return new Docker();

  if (config.DOCKER_HOST.startsWith('tcp://') || config.DOCKER_HOST.startsWith('http://')) {
    const url = new URL(config.DOCKER_HOST);
    return new Docker({ host: url.hostname, port: parseInt(url.port || '2375', 10) });
  }

  const socketPath = config.DOCKER_HOST.replace(/^unix:\/\//, '');
  return new Docker({ socketPath });
}

async function runContainerCommand(container: Docker.Container, cmd: string): Promise<void> {
  const exec = await container.exec({
    Cmd: ['sh', '-c', cmd],
    AttachStdout: true,
    AttachStderr: true,
  });

  await new Promise<void>((resolve, reject) => {
    exec.start({}, (err) => {
      if (err) return reject(err);
      return resolve();
    });
  });

  const startedAt = Date.now();
  let result = await exec.inspect();
  while (result.Running) {
    if (Date.now() - startedAt > 15_000) {
      throw new Error('Timed out waiting for container command to finish');
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    result = await exec.inspect();
  }

  if (result.ExitCode && result.ExitCode !== 0) {
    throw new Error(`Container command failed with exit code ${result.ExitCode}`);
  }
}

async function setupLocalDockerSSH(containerName: string, c: any, sandbox: SandboxRecord | null) {
  const docker = getDockerClient();
  const container = docker.getContainer(containerName);
  try {
    const containerInfo = await container.inspect();
    if (!containerInfo.State?.Running) {
      throw new Error('Sandbox is not running.');
    }
  } catch (e: any) {
    if (e?.statusCode === 404 || String(e?.message || '').includes('No such container')) {
      throw new Error('No sandbox container found. Start your Local Docker sandbox first.');
    }
    throw e;
  }

  const connection = buildConnectionForLocalDocker(c, sandbox);
  const { privateKey, publicKey } = generateKeypair(connection.host_alias);

  await runContainerCommand(
    container,
    buildAuthorizedKeysInstallCommand(publicKey, '/config/.ssh'),
  );
  await verifyAuthorizedKeyInContainer(container, publicKey, '/config/.ssh');
  console.log(`[SSH] Public key injected into container ${containerName}`);

  return buildSSHSetupPayload({
    connection,
    privateKey,
    publicKey,
    keyComment: connection.host_alias,
  });
}

// ─── JustAVPS: inject into sandbox container (NOT the VPS host) ──────────────
// Previously this returned VPS host root SSH keys — giving access to the bare
// machine instead of the sandboxed container. This is now fixed:
//   1. Generate a fresh ed25519 keypair (same as local_docker)
//   2. Resolve the JustAVPS host toolbox endpoint (via CF proxy)
//   3. Inject the public key into /config/.ssh/authorized_keys inside the container
//   4. Return connection to host port 22 as user abc, where host sshd is
//      configured to auth against container keys and force every abc session
//      into the workload container.

async function setupJustavpsSSH(externalId: string) {
  const { JustAVPSProvider } = await import('../providers/justavps');

  const provider = new JustAVPSProvider();

  // buildConnectionForJustavps below verifies machine.status === 'ready' and
  // requires machine.ip — that is the only "is the VM up?" gate we need here.
  //
  // Historically this called provider.ensureRunning(externalId), which always
  // forced a full host recovery (systemctl restart justavps-docker + wait
  // loops, up to ~240s per attempt, 20 retries → ~1h worst-case). That
  // restarted the sandbox container on every SSH click — hence the "machine
  // turned off" reports when the restart stumbled. Key injection only needs
  // a healthy container; if the container is down, injectPublicKeyViaHostExec
  // -WithRetry will fail fast within its 120s window with a clear error, and
  // the user can hit the explicit Restart action to trigger recovery.
  const connection = await buildConnectionForJustavps(externalId);

  // Generate a fresh keypair for this session
  const { privateKey, publicKey } = generateKeypair(connection.host_alias);

  // Resolve sandbox endpoint via the CF proxy (same path used by all other API calls)
  const endpoint = await provider.resolveEndpoint(externalId);

  // Inject public key into the Dockerized sandbox via the JustAVPS host toolbox.
  // resolveEndpoint() targets the host, so we exec on the VPS and then docker
  // exec into the workload container.
  await injectPublicKeyViaHostExecWithRetry(endpoint, publicKey);
  await verifyPublicKeyViaHostExec(endpoint, publicKey);
  console.log(`[SSH] Public key injected into JustAVPS container ${externalId}`);

  return buildSSHSetupPayload({
    connection,
    privateKey,
    publicKey,
    keyComment: connection.host_alias,
  });
}

async function resolveSshContext(c: any): Promise<{ sandbox: SandboxRecord | null; provider: string | null; externalId: string | null; containerName: string }> {
  const body = await c.req.json().catch(() => ({}));
  const requestedSandboxId = (body?.sandboxId as string | undefined) || c.req.query('sandboxId') || undefined;
  const userId = c.get('userId');

  let sandbox: SandboxRecord | null = null;
  if (userId) {
    try {
      sandbox = await resolveSandboxRecord(userId, requestedSandboxId);
    } catch {
      sandbox = null;
    }
  }

  const provider = sandbox?.provider ?? null;
  const externalId = sandbox?.externalId ?? null;
  const containerName = sandbox?.externalId && provider === 'local_docker'
    ? sandbox.externalId
    : config.SANDBOX_CONTAINER_NAME;

  return { sandbox, provider, externalId, containerName };
}

sshRouter.get('/connection', async (c) => {
  try {
    const { sandbox, provider, externalId } = await resolveSshContext(c);

    if (provider === 'justavps') {
      if (!externalId) {
        return c.json({ success: false, error: 'No JustAVPS machine found for this sandbox.' }, 400);
      }
      const data = await buildConnectionForJustavps(externalId);
      return c.json({ success: true, data });
    }

    const data = buildConnectionForLocalDocker(c, sandbox);
    return c.json({ success: true, data });
  } catch (err) {
    console.error('[SSH] connection error:', err);
    return c.json({ success: false, error: err instanceof Error ? err.message : 'Failed to resolve SSH connection' }, 500);
  }
});

// ─── Route ───────────────────────────────────────────────────────────────────

sshRouter.post('/setup', async (c) => {
  try {
    const { sandbox, provider, externalId, containerName } = await resolveSshContext(c);

    let data;

    if (provider === 'justavps') {
      if (!externalId) {
        return c.json({ success: false, error: 'No JustAVPS machine found for this sandbox.' }, 400);
      }
      data = await setupJustavpsSSH(externalId);
    } else {
      data = await setupLocalDockerSSH(containerName, c, sandbox);
    }

    return c.json({ success: true, data });
  } catch (err) {
    console.error('[SSH] setup error:', err);
    return c.json({ success: false, error: err instanceof Error ? err.message : 'Failed to setup SSH' }, 500);
  }
});

export { sshRouter };
