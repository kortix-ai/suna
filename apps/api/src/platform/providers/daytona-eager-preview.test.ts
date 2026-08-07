import { expect, mock, test } from 'bun:test';

mock.module('../../config', () => ({
  config: {
    DAYTONA_API_KEY: 'test-key',
    DAYTONA_SERVER_URL: '',
    DAYTONA_TARGET: '',
    INTERNAL_KORTIX_ENV: 'test',
    KORTIX_URL: 'https://api.example.com',
    KORTIX_SANDBOX_AUTOARCHIVE_MINUTES: 4320,
    KORTIX_SANDBOX_AUTODELETE_MINUTES: -1,
  },
  SANDBOX_VERSION: 'test-version',
}));

mock.module('../../shared/db', () => ({ db: {} }));

let previewLinkCalls: number[] = [];
let processCommands: Array<{ command: string; timeout: number | undefined }> = [];
let previewLinkImpl: (port: number) => Promise<unknown> = async (port) => {
  previewLinkCalls.push(port);
  return { url: 'https://preview.example.com', token: 'tok' };
};

mock.module('../../shared/daytona', () => ({
  getDaytona: () => ({
    create: async () => ({
      id: 'sbx-eager-1',
      getPreviewLink: (port: number) => previewLinkImpl(port),
    }),
    get: async () => ({
      process: {
        executeCommand: async (command: string, _cwd?: string, _env?: Record<string, string>, timeout?: number) => {
          processCommands.push({ command, timeout });
          return { exitCode: 0, result: 'started' };
        },
      },
    }),
  }),
  archiveDaytonaSandboxById: async () => ({ ok: true }),
  isDaytonaDiskQuotaError: () => false,
  listStoppedDaytonaSandboxesOldestFirst: async function* () {},
}));

mock.module('../../projects/disk-quota-guard', () => ({
  triggerEmergencyDiskArchiveSweep: () => {},
}));

mock.module('../service-key', () => ({ serviceKeyForExternalId: async () => null }));
mock.module('../sandbox-frontend-url', () => ({ sandboxFrontendBaseUrl: () => 'https://app.example.com' }));

const { DaytonaProvider } = await import('./daytona');

const createOpts = {
  accountId: 'acc-1',
  userId: 'user-1',
  name: 'session-eager',
  snapshot: 'kortix-default-test',
  envVars: { KORTIX_SANDBOX_TOKEN: 'kortix_sb_test' },
} as never;

const settle = () => new Promise((r) => setTimeout(r, 50));

test('create() eagerly warms the port-8000 preview route so the edge is live before the first proxied call', async () => {
  previewLinkCalls = [];
  const result = await new DaytonaProvider().create(createOpts);
  await settle();

  expect(result.externalId).toBe('sbx-eager-1');
  expect(previewLinkCalls).toEqual([8000]);
});

test('a failing preview-link warm never fails provisioning — resolveIngress still resolves it lazily', async () => {
  previewLinkCalls = [];
  previewLinkImpl = async (port) => {
    previewLinkCalls.push(port);
    throw new Error('edge not ready');
  };

  const result = await new DaytonaProvider().create(createOpts);
  await settle();

  expect(result.externalId).toBe('sbx-eager-1');
  expect(result.baseUrl).toBe('https://api.example.com/v1/p/sbx-eager-1/8000');
  expect(previewLinkCalls).toEqual([8000]);

  previewLinkImpl = async (port) => {
    previewLinkCalls.push(port);
    return { url: 'https://preview.example.com', token: 'tok' };
  };
});

test('provisioning does not wait on the warm — create resolves before the link does', async () => {
  previewLinkCalls = [];
  let released = false;
  previewLinkImpl = async (port) => {
    previewLinkCalls.push(port);
    await new Promise((r) => setTimeout(r, 400));
    released = true;
    return { url: 'https://preview.example.com', token: 'tok' };
  };

  await new DaytonaProvider().create(createOpts);
  expect(released).toBe(false);

  previewLinkImpl = async (port) => {
    previewLinkCalls.push(port);
    return { url: 'https://preview.example.com', token: 'tok' };
  };
});

test('App workload bootstrap starts kortix-appd through the Daytona toolbox', async () => {
  processCommands = [];

  await new DaytonaProvider().ensureAppRuntimeStarted('sbx-eager-1');

  expect(processCommands).toHaveLength(1);
  expect(processCommands[0]?.command).toContain('/kortix/bin/kortix-appd');
  expect(processCommands[0]?.command).toContain('/tmp/kortix-appd.pid');
  expect(processCommands[0]?.timeout).toBe(15);
});
