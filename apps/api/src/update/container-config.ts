import type { ResolvedEndpoint } from '../platform/providers';
import { execOnHost } from './exec';
import { config } from '../config';

export interface ContainerConfig {
  image: string;
  name: string;
  volumes: string[];
  ports: string[];
  privileged: boolean;
  caps: string[];
  shmSize: string;
  envFile: string;
  securityOpt: string[];
}

const CONFIG_PATH = '/workspace/.kortix/container.json';

export const JUSTAVPS_ENV_FILE = '/etc/justavps/env';
export const JUSTAVPS_SERVICE_NAME = 'justavps-docker';
export const JUSTAVPS_STARTUP_PATCH_HOST = '/usr/local/bin/kortix-startup-patch.sh';
export const JUSTAVPS_STARTUP_PATCH_MOUNT = `${JUSTAVPS_STARTUP_PATCH_HOST}:/ephemeral/startup.sh:ro`;

export const DEFAULT_PORTS = [
  '3000:3000', '3456:3456', '8000:8000', '8080:8080',
  '6080:6080', '6081:6081', '3210:3210',
  '3211:3211', '9223:9223', '9224:9224', '22222:22',
];

export function sanitizePorts(ports: string[]): string[] {
  return ports;
}

export async function readContainerConfig(
  endpoint: ResolvedEndpoint,
): Promise<ContainerConfig | null> {
  const result = await execOnHost(endpoint, `cat ${CONFIG_PATH} 2>/dev/null`, 5);
  if (!result.success || !result.stdout.trim()) return null;
  try {
    const config = JSON.parse(result.stdout.trim()) as ContainerConfig;
    normalizeManagedVolumes(config);
    const sanitizedPorts = sanitizePorts(config.ports || []);
    const portsChanged = JSON.stringify(sanitizedPorts) !== JSON.stringify(config.ports || []);
    config.ports = sanitizedPorts.length > 0 ? sanitizedPorts : DEFAULT_PORTS;

    const inspect = await execOnHost(
      endpoint,
      `docker inspect --format='{{.Config.Image}}' '${config.name}' 2>/dev/null`,
      5,
    );
    if (inspect.success) {
      const runningImage = inspect.stdout.trim().replace(/'/g, '');
      if (runningImage && runningImage !== config.image) {
        config.image = runningImage;
        await writeContainerConfig(endpoint, config);
      } else if (portsChanged) {
        await writeContainerConfig(endpoint, config);
      }
    } else if (portsChanged) {
      await writeContainerConfig(endpoint, config);
    }

    return config;
  } catch {
    return null;
  }
}

export async function writeContainerConfig(
  endpoint: ResolvedEndpoint,
  config: ContainerConfig,
): Promise<void> {
  normalizeManagedVolumes(config);
  const json = JSON.stringify({
    ...config,
    ports: sanitizePorts(config.ports || []).length > 0 ? sanitizePorts(config.ports || []) : DEFAULT_PORTS,
  }, null, 2);
  const b64 = Buffer.from(json).toString('base64');
  await execOnHost(
    endpoint,
    `mkdir -p /workspace/.kortix && echo '${b64}' | base64 -d > ${CONFIG_PATH}`,
    5,
  );
}

export async function buildFromInspect(
  endpoint: ResolvedEndpoint,
): Promise<ContainerConfig | null> {
  const names = [config.SANDBOX_CONTAINER_NAME, 'kortix-sandbox', 'justavps-workload'];
  for (const name of names) {
    const result = await execOnHost(
      endpoint,
      `docker inspect '${name}' --format='{{json .}}' 2>/dev/null`,
      10,
    );
    if (!result.success) continue;

    try {
      const info = JSON.parse(result.stdout.trim().replace(/^'|'$/g, ''));
      const hostConfig = info.HostConfig || {};
      const containerConfig = info.Config || {};

      const volumes = (hostConfig.Binds || []) as string[];
      const portBindings = hostConfig.PortBindings || {};
      const ports: string[] = [];
      for (const [containerPort, bindings] of Object.entries(portBindings)) {
        const port = containerPort.replace('/tcp', '');
        for (const binding of bindings as Array<{ HostPort: string }>) {
          ports.push(`${binding.HostPort}:${port}`);
        }
      }

      const envFile = findEnvFile(hostConfig);

      return {
        image: containerConfig.Image || '',
        name,
        volumes: volumes.length > 0 ? volumes : ['kortix-data:/workspace', 'kortix-data:/config'],
        ports: sanitizePorts(ports).length > 0 ? sanitizePorts(ports) : DEFAULT_PORTS,
        privileged: Boolean(hostConfig.Privileged),
        caps: (hostConfig.CapAdd || []) as string[],
        shmSize: formatShmSize(hostConfig.ShmSize),
        envFile: envFile || '/etc/justavps/env',
        securityOpt: (hostConfig.SecurityOpt || []) as string[],
      };
    } catch {
      continue;
    }
  }
  return null;
}

function findEnvFile(hostConfig: Record<string, unknown>): string | null {
  return null;
}

function formatShmSize(bytes: number | undefined): string {
  if (!bytes) return '2g';
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${Math.round(gb)}g`;
  const mb = bytes / (1024 * 1024);
  return `${Math.round(mb)}m`;
}

function sq(val: string): string {
  return `'${val.replace(/'/g, "'\\''")}'`;
}

function normalizeManagedVolumes(config: ContainerConfig): void {
  if (!isJustAVPSManagedConfig(config)) return;
  const volumes = [...(config.volumes || [])];
  if (!volumes.includes(JUSTAVPS_STARTUP_PATCH_MOUNT)) {
    volumes.unshift(JUSTAVPS_STARTUP_PATCH_MOUNT);
  }
  config.volumes = volumes;
}

export function buildDockerRunCommand(config: ContainerConfig): string {
  return buildDockerRunCommandWithMode(config, true);
}

export function buildForegroundDockerRunCommand(config: ContainerConfig): string {
  return buildDockerRunCommandWithMode(config, false);
}

function buildDockerRunCommandWithMode(config: ContainerConfig, detached: boolean): string {
  normalizeManagedVolumes(config);
  const args: string[] = [detached ? 'docker run -d --rm' : 'docker run --rm'];
  args.push(`--name ${sq(config.name)}`);
  if (config.envFile) args.push(`--env-file ${sq(config.envFile)}`);

  const imageTag = config.image.includes(':') ? config.image.split(':').pop() : 'unknown';
  args.push(`-e SANDBOX_VERSION=${sq(imageTag!)}`);
  if (isJustAVPSManagedConfig(config)) {
    args.push('-e KORTIX_ENABLE_INNER_DOCKER=0');
  }
  if (config.privileged) args.push('--privileged');

  for (const cap of config.caps) {
    const stripped = cap.replace(/^CAP_/, '');
    args.push(`--cap-add ${sq(stripped)}`);
  }
  for (const opt of config.securityOpt) args.push(`--security-opt ${sq(opt)}`);
  if (config.shmSize) args.push(`--shm-size ${sq(config.shmSize)}`);
  for (const vol of config.volumes) args.push(`-v ${sq(vol)}`);
  for (const port of sanitizePorts(config.ports)) args.push(`-p ${sq(port)}`);
  args.push(sq(config.image));
  return args.join(' ');
}

export function isJustAVPSManagedConfig(config: ContainerConfig): boolean {
  return config.envFile === JUSTAVPS_ENV_FILE || config.name === 'justavps-workload';
}

export function buildManagedServiceStartScript(config: ContainerConfig): string {
  const runCommand = buildForegroundDockerRunCommand(config);
  const envFile = sq(config.envFile || JUSTAVPS_ENV_FILE);
  const name = sq(config.name);

  return [
    '#!/bin/bash',
    'set -euo pipefail',
    `ENV_FILE=${envFile}`,
    `CONTAINER_NAME=${name}`,
    'BOOT_TIME=$(stat -c %Y /proc/1 2>/dev/null || echo 0)',
    'for i in $(seq 1 120); do',
    '  if [ -s "$ENV_FILE" ]; then',
    '    ENV_MTIME=$(stat -c %Y "$ENV_FILE" 2>/dev/null || stat -f %m "$ENV_FILE" 2>/dev/null || echo 0)',
    '    if [ "$ENV_MTIME" -gt "$BOOT_TIME" ]; then',
    '      break',
    '    fi',
    '    if grep -Eq "^(INTERNAL_SERVICE_KEY|KORTIX_TOKEN|KORTIX_API_URL)=" "$ENV_FILE" 2>/dev/null; then',
    '      echo "[kortix] Reusing persisted env file $ENV_FILE"',
    '      break',
    '    fi',
    '  fi',
    '  sleep 1',
    'done',
    '[ -s "$ENV_FILE" ] || touch "$ENV_FILE"',
    'docker rm -f "$CONTAINER_NAME" 2>/dev/null || true',
    `exec ${runCommand}`,
  ].join('\n');
}
