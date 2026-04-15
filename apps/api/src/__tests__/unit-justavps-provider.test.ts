import { describe, test, expect } from 'bun:test';
import { buildCustomerCloudInitScript, buildJustAVPSHostRecoveryCommand } from '../platform/providers/justavps';

describe('JustAVPS provider bootstrap script resolution', () => {
  test('buildCustomerCloudInitScript embeds sandbox bootstrap', () => {
    const script = buildCustomerCloudInitScript('kortix/computer:0.8.20');
    expect(script).toContain('/usr/local/bin/kortix-start-sandbox.sh');
    expect(script).toContain('kortix/computer:0.8.20');
    expect(script).toContain('raw.githubusercontent.com/kortix-ai/suna/main/scripts/start-sandbox.sh');
  });

  test('buildJustAVPSHostRecoveryCommand restarts the workload and verifies health', () => {
    const command = buildJustAVPSHostRecoveryCommand();
    expect(command).toContain('systemctl start docker.service');
    expect(command).toContain('systemctl restart justavps-docker');
    expect(command).toContain('docker inspect --format="{{.State.Status}}" justavps-workload');
    expect(command).toContain('curl -fsS http://localhost:8000/kortix/health');
  });
});
