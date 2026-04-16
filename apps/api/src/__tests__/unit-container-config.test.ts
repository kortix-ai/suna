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
  test('default port list does not bind host port 3456', () => {
    expect(DEFAULT_PORTS).not.toContain('3456:3456');
  });

  test('buildContainerConfig inherits non-conflicting default ports', () => {
    const config = buildContainerConfig({ image: 'kortix/computer:0.8.20' });
    expect(config.ports).toEqual(DEFAULT_PORTS);
    expect(config.privileged).toBe(true);
    expect(config.ports).not.toContain('3456:3456');
    expect(config.volumes).toContain(JUSTAVPS_STARTUP_PATCH_MOUNT);
  });

  test('buildDockerRunCommand does not emit 3456 binding by default', () => {
    const config = buildContainerConfig({ image: 'kortix/computer:0.8.20' });
    const command = buildDockerRunCommand(config);
    expect(command).not.toContain('-p 3456:3456');
    expect(command).toContain('--privileged');
    expect(command).toContain("-p '8000:8000'");
  });

  test('sanitizePorts strips legacy 3456 host binding', () => {
    expect(sanitizePorts(['3000:3000', '3456:3456', '8000:8000'])).toEqual([
      '3000:3000',
      '8000:8000',
    ]);
  });

  test('buildContainerConfig sanitizes custom ports too', () => {
    const config = buildContainerConfig({
      image: 'kortix/computer:0.8.20',
      ports: ['3456:3456', '8000:8000'],
    });
    expect(config.ports).toEqual(['8000:8000']);
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
