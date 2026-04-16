import { beforeEach, describe, expect, mock, test } from 'bun:test';

let commandLog: string[] = [];
let responses = new Map<string, Array<string | Error>>();

mock.module('child_process', () => ({
  execSync: (command: string) => {
    commandLog.push(command);
    const queue = responses.get(command);
    const response = queue?.shift();
    if (response instanceof Error) throw response;
    if (typeof response === 'string') return Buffer.from(response);
    throw new Error(`unexpected command: ${command}`);
  },
}));

const { checkLocalSandboxHealth } = await import('../platform/services/local-sandbox-health');

describe('checkLocalSandboxHealth', () => {
  beforeEach(() => {
    commandLog = [];
    responses = new Map<string, Array<string | Error>>();
  });

  test('restarts the managed service when the container is missing', () => {
    responses.set('docker info', ['Docker 26.1.0']);
    responses.set(`docker inspect 'kortix-sandbox' --format "{{.State.Status}}"`, [new Error('missing'), new Error('missing')]);
    responses.set(`docker inspect 'justavps-workload' --format "{{.State.Status}}"`, [new Error('missing'), 'running']);
    responses.set('systemctl cat justavps-docker', ['[Unit]']);
    responses.set('systemctl restart justavps-docker', ['']);

    const result = checkLocalSandboxHealth();

    expect(result.docker.ok).toBe(true);
    expect(result.sandbox.ok).toBe(true);
    expect(result.sandbox.recovered).toBe(true);
    expect(commandLog).toContain('systemctl restart justavps-docker');
  });
});
