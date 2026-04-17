import { beforeEach, describe, expect, mock, test } from 'bun:test';

const phaseCalls: string[] = [];
const stepCalls = { ensure: 0, checkpoint: 0 };

mock.module('@kortix/db', () => ({ sandboxes: { sandboxId: 'sandboxId' } }));
mock.module('drizzle-orm', () => ({ eq: () => ({}) }));
mock.module('../shared/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => ([{ sandboxId: 'sbx_1', externalId: 'ext_1', provider: 'justavps' }]),
        }),
      }),
    }),
  },
}));
mock.module('../config', () => ({ config: { SANDBOX_IMAGE: 'kortix/computer:0.8.40' } }));
mock.module('../platform/providers', () => ({
  getProvider: () => ({ resolveEndpoint: async () => ({ url: 'http://sandbox', headers: {} }) }),
}));
mock.module('../platform/providers/justavps', () => ({ JustAVPSProvider: class {} }));
mock.module('../update/status', () => ({
  setPhase: async (_id: string, phase: string) => { phaseCalls.push(phase); },
  clearUpdateStatus: async () => {},
  isUpdateCancellationRequested: async () => false,
}));
mock.module('../update/container-config', () => ({
  readContainerConfig: async () => ({
    image: 'kortix/computer:0.8.40',
    name: 'justavps-workload',
    volumes: [],
    ports: [],
    privileged: true,
    caps: [],
    shmSize: '2g',
    envFile: '/etc/justavps/env',
    securityOpt: [],
  }),
  writeContainerConfig: async () => {},
  buildFromInspect: async () => null,
}));
mock.module('../update/steps', () => ({
  getCurrentImage: async () => ({ success: true, stdout: '', stderr: '', exitCode: 0, durationMs: 0 }),
  pullImage: async () => ({ success: true, stdout: 'pulled', stderr: '', exitCode: 0, durationMs: 1000 }),
  checkDockerDaemon: async () => ({ success: true, stdout: 'Docker 1', stderr: '', exitCode: 0, durationMs: 0 }),
  checkDiskSpace: async () => ({ success: true, stdout: '10GB free', stderr: '', exitCode: 0, durationMs: 0 }),
  checkImageExistsOnHub: async () => ({ success: true, stdout: 'exists', stderr: '', exitCode: 0, durationMs: 0 }),
  ensureContainerRunning: async () => {
    stepCalls.ensure++;
    return { success: true, stdout: stepCalls.ensure === 1 ? 'running' : 'recovered', stderr: '', exitCode: 0, durationMs: 0 };
  },
  checkpointSqlite: async () => {
    stepCalls.checkpoint++;
    return stepCalls.checkpoint === 1
      ? { success: false, stdout: '', stderr: 'Error response from daemon: No such container: justavps-workload', exitCode: 1, durationMs: 0 }
      : { success: true, stdout: 'ok', stderr: '', exitCode: 0, durationMs: 0 };
  },
  stopAndStartContainer: async () => ({ success: true, stdout: '', stderr: '', exitCode: 0, durationMs: 0 }),
  verifyContainer: async () => ({ success: true, stdout: 'ok', stderr: '', exitCode: 0, durationMs: 0 }),
}));

const { executeUpdate } = await import('../update/executor');

describe('executeUpdate container recovery', () => {
  beforeEach(() => {
    phaseCalls.length = 0;
    stepCalls.ensure = 0;
    stepCalls.checkpoint = 0;
  });

  test('retries checkpoint after auto-recovering a missing container', async () => {
    await executeUpdate('sbx_1', '0.8.41');

    expect(stepCalls.ensure).toBe(2);
    expect(stepCalls.checkpoint).toBe(2);
    expect(phaseCalls).toContain('complete');
  });
});
