import type { ResolvedEndpoint } from '../platform/providers';
import { execOnHost } from './exec';
import { config } from '../config';

export interface ContainerConfig {
  image: string;
  name: string;
  volumes: string[];
  ports: string[];
  caps: string[];
  shmSize: string;
  envFile: string;
  securityOpt: string[];
}

const CONFIG_PATH = '/workspace/.kortix/container.json';

// Port mapping for cloud/JustAVPS sandboxes.
export const DEFAULT_PORTS = [
  '3000:3000', '8000:8000', '8080:8080',
  '6080:6080', '6081:6081', '3210:3210',
  '3211:3211', '9223:9223', '9224:9224', '22222:22',
];

export function sanitizePorts(ports: string[]): string[] {
  return ports.filter((port) => port !== '3456:3456');
}

export async function readContainerConfig(
  endpoint: ResolvedEndpoint,
): Promise<ContainerConfig | null> {
  const result = await execOnHost(endpoint, `cat ${CONFIG_PATH} 2>/dev/null`, 5);
  if (!result.success || !result.stdout.trim()) return null;
  try {
    const config = JSON.parse(result.stdout.trim()) as ContainerConfig;
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
  // Docker stores env-file contents inline, but we can check common paths
  return null;
}

function formatShmSize(bytes: number | undefined): string {
  if (!bytes) return '2g';
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${Math.round(gb)}g`;
  const mb = bytes / (1024 * 1024);
  return `${Math.round(mb)}m`;
}

// Shell-quote a value: wraps in single quotes, escaping any embedded single quotes.
function sq(val: string): string {
  return `'${val.replace(/'/g, "'\\''")}'`;
}

export function buildDockerRunCommand(config: ContainerConfig): string {
  const args: string[] = ['docker run -d --rm'];
  args.push(`--name ${sq(config.name)}`);
  if (config.envFile) args.push(`--env-file ${sq(config.envFile)}`);

  // Inject SANDBOX_VERSION from the image tag so the sandbox health endpoint
  // reports the correct version. This overrides any stale value in the env file.
  const imageTag = config.image.includes(':') ? config.image.split(':').pop() : 'unknown';
  args.push(`-e SANDBOX_VERSION=${sq(imageTag!)}`);

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
