import type { ResolvedEndpoint } from '../platform/providers';
import { execOnHost } from './exec';
import {
  JUSTAVPS_ENV_FILE,
  JUSTAVPS_STARTUP_PATCH_MOUNT,
  writeContainerConfig,
  buildDockerRunCommand,
  DEFAULT_PORTS,
  sanitizePorts,
  type ContainerConfig,
} from './container-config';
import { config } from '../config';

export interface SetupOpts {
  image: string;
  envFile?: string;
  ports?: string[];
  containerName?: string;
  volumeName?: string;
}

export function buildContainerConfig(opts: SetupOpts): ContainerConfig {
  const volumeName = opts.volumeName || 'kortix-data';
  const ports = sanitizePorts(opts.ports || DEFAULT_PORTS);
  const envFile = opts.envFile || JUSTAVPS_ENV_FILE;
  const volumes = [`${volumeName}:/workspace`, `${volumeName}:/config`];
  if (envFile === JUSTAVPS_ENV_FILE && !volumes.includes(JUSTAVPS_STARTUP_PATCH_MOUNT)) {
    volumes.unshift(JUSTAVPS_STARTUP_PATCH_MOUNT);
  }
  return {
    image: opts.image,
    name: opts.containerName || config.SANDBOX_CONTAINER_NAME,
    volumes,
    ports,
    caps: ['SYS_ADMIN'],
    shmSize: '2g',
    envFile,
    securityOpt: ['seccomp=unconfined'],
  };
}

export async function deploySandbox(
  endpoint: ResolvedEndpoint,
  opts: SetupOpts,
): Promise<ContainerConfig> {
  const config = buildContainerConfig(opts);

  // Pull image if not cached
  const exists = await execOnHost(
    endpoint,
    `docker image inspect ${config.image} >/dev/null 2>&1 && echo cached`,
    10,
  );

  if (exists.stdout?.trim() !== 'cached') {
    console.log(`[SETUP] Pulling ${config.image}...`);
    await execOnHost(
      endpoint,
      `systemd-run --unit=kortix-image-pull docker pull ${config.image}`,
      15,
    );

    // Poll until image is available (up to 10 minutes for first pull)
    for (let i = 0; i < 120; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      const check = await execOnHost(
        endpoint,
        `docker image inspect ${config.image} >/dev/null 2>&1 && echo ready`,
        10,
      );
      if (check.stdout?.trim() === 'ready') break;
      if (i === 119) throw new Error(`Image pull timed out: ${config.image}`);
    }
  }

  // Start container
  const runCmd = buildDockerRunCommand(config);
  const result = await execOnHost(endpoint, runCmd, 30);
  if (!result.success) {
    throw new Error(`Failed to start container: ${result.stderr}`);
  }

  // Write config to persistent volume
  await writeContainerConfig(endpoint, config);

  console.log(`[SETUP] Sandbox deployed: ${config.name} running ${config.image}`);
  return config;
}
