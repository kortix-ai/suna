import { describe, test, expect } from 'bun:test';
import {
  DEFAULT_PORTS,
  JUSTAVPS_ENV_FILE,
  JUSTAVPS_STARTUP_PATCH_MOUNT,
  buildDockerRunCommand,
  buildForegroundDockerRunCommand,
  buildManagedServiceStartScript,
  isJustAVPSManagedConfig,
  sanitizePorts,
} from '../update/container-config';
import { buildContainerConfig } from '../update/setup';

describe('sandbox container port config', () => {
  test('default port list binds host port 3456 for legacy daemon compat', () => {
    expect(DEFAULT_PORTS).toContain('3456:3456');
    expect(DEFAULT_PORTS).toContain('8000:8000');
  });

  test('buildContainerConfig inherits default ports', () => {
    const config = buildContainerConfig({ image: 'kortix/computer:0.8.20' });
    expect(config.ports).toEqual(DEFAULT_PORTS);
    expect(config.privileged).toBe(true);
    expect(config.ports).toContain('3456:3456');
    expect(config.ports).toContain('8000:8000');
    expect(config.volumes).toContain(JUSTAVPS_STARTUP_PATCH_MOUNT);
  });

  test('buildDockerRunCommand emits both 3456 and 8000 bindings', () => {
    const config = buildContainerConfig({ image: 'kortix/computer:0.8.20' });
    const command = buildDockerRunCommand(config);
    expect(command).toContain('--privileged');
    expect(command).toContain("-p '3456:3456'");
    expect(command).toContain("-p '8000:8000'");
  });

  test('sanitizePorts passes through (no legacy strip)', () => {
    expect(sanitizePorts(['3000:3000', '3456:3456', '8000:8000'])).toEqual([
      '3000:3000',
      '3456:3456',
      '8000:8000',
    ]);
  });

  test('buildContainerConfig preserves custom ports including 3456', () => {
    const config = buildContainerConfig({
      image: 'kortix/computer:0.8.20',
      ports: ['3456:3456', '8000:8000'],
    });
    expect(config.ports).toEqual(['3456:3456', '8000:8000']);
  });

  test('foreground run command omits detached flag for systemd-managed sandboxes', () => {
    const config = buildContainerConfig({ image: 'kortix/computer:0.8.20', envFile: JUSTAVPS_ENV_FILE, containerName: 'justavps-workload' });
    const command = buildForegroundDockerRunCommand(config);
    expect(command).toContain('docker run --rm');
    expect(command).not.toContain('docker run -d --rm');
  });

  test('justavps env file marks config as systemd-managed', () => {
    const config = buildContainerConfig({ image: 'kortix/computer:0.8.20', envFile: JUSTAVPS_ENV_FILE, containerName: 'justavps-workload' });
    expect(isJustAVPSManagedConfig(config)).toBe(true);
  });

  test('managed service start script reuses persisted env when already present', () => {
    const config = buildContainerConfig({ image: 'kortix/computer:0.8.20', envFile: JUSTAVPS_ENV_FILE, containerName: 'justavps-workload' });
    const script = buildManagedServiceStartScript(config);
    expect(script).toContain('Reusing persisted env file');
    expect(script).toContain('grep -Eq "^(INTERNAL_SERVICE_KEY|KORTIX_TOKEN|KORTIX_API_URL)="');
    expect(script).toContain('exec docker run --rm');
    expect(script).toContain('--privileged');
    expect(script).toContain('KORTIX_ENABLE_INNER_DOCKER=0');
    expect(script).toContain(JUSTAVPS_STARTUP_PATCH_MOUNT);
  });
});
