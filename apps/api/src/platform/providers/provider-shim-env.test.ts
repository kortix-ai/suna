/**
 * The in-guest egress shim is the delivery mechanism for egress-enforced
 * secrets on EVERY provider, and it arms itself
 * purely from what provisioning put in the sandbox environment. Four variables
 * decide it: three ride the caller's `opts.envVars` (the capability catalog,
 * the project id, the session credential) and the fourth — `KORTIX_API_URL` —
 * each provider synthesizes for itself. Drop any one and `resolveShimConfig`
 * returns null, the shim never starts, and the agent's request leaves without
 * the credential: the upstream answers 401 and the secret looks broken rather
 * than undelivered.
 *
 * The contract is asserted against the daemon's own resolver rather than a
 * copied list of variable names, so renaming one on either side fails here
 * instead of silently disarming the shim in production.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

import { resolveShimConfig } from '../../../../kortix-sandbox-agent-server/src/egress-shim/rules';

// Each provider is constructed directly rather than through the registry, so
// nothing here needs an admission list or a real credential. Assigned with
// `??=` only: `process.env` is one object shared by every co-running file, and
// overwriting a variable a neighbouring suite already set is how a test starts
// failing in company while passing alone.
process.env.KORTIX_URL ??= 'https://api.example.com';
process.env.E2B_API_KEY ??= 'e2b_test_key';
process.env.DATABASE_URL ??= 'postgres://x';
process.env.SUPABASE_URL ??= 'http://supabase.test';

/** Exactly what the guest daemon reads to decide whether to run a shim. */
const SHIM_ENV_NAMES = [
  'KORTIX_SECRET_CAPABILITIES',
  'KORTIX_API_URL',
  'KORTIX_PROJECT_ID',
  'KORTIX_CLI_TOKEN',
] as const;

const CAPABILITIES = JSON.stringify({
  version: 1,
  capabilities: [{ identifier: 'billing-api', delivery: 'network', hosts: ['api.example.com'] }],
});

/**
 * The session slice of the environment, as `buildSessionSandboxEnvVars` hands
 * it to `create()`. `KORTIX_API_URL` is deliberately absent: every provider
 * derives it from `config.KORTIX_URL` itself, so a provider that stopped doing
 * that would disarm the shim without any caller changing.
 */
const SESSION_ENV = {
  KORTIX_SANDBOX_TOKEN: 'kortix_sb_daemon_identity',
  KORTIX_PROJECT_ID: 'proj-shim',
  KORTIX_CLI_TOKEN: 'kortix_pat_session_credential',
  KORTIX_SECRET_CAPABILITIES: CAPABILITIES,
};

/** The env map the provider under test actually handed to its runtime SDK. */
let deliveredEnv: Record<string, string> | undefined;

function fakeE2BSandbox() {
  return {
    sandboxId: 'sb-shim',
    trafficAccessToken: 'traffic-shim',
    files: {
      write: async (path: string) => ({ path }),
    },
    commands: {
      list: async () => [],
      run: async () => ({ exitCode: 0 }),
    },
    kill: async () => true,
    getHost: (port: number) => `${port}-sb-shim.e2b.test`,
  };
}

mock.module('e2b', () => ({
  Sandbox: {
    create: async (_template: string, opts: { envs: Record<string, string> }) => {
      deliveredEnv = opts.envs;
      return fakeE2BSandbox();
    },
  },
  SandboxNotFoundError: class extends Error {},
}));

mock.module('../../shared/daytona', () => ({
  getDaytona: () => ({
    create: async (params: { envVars: Record<string, string> }) => {
      deliveredEnv = params.envVars;
      return {
        id: 'sbx-shim',
        getPreviewLink: async () => ({ url: 'https://sbx-shim.daytona.test' }),
      };
    },
  }),
  // Disk-quota-guard deps: unused by create() here, but imported at module load
  // so they must exist as named exports for the mock to satisfy daytona.ts.
  archiveDaytonaSandboxById: async () => ({ ok: true }),
  isDaytonaDiskQuotaError: () => false,
  listStoppedDaytonaSandboxesOldestFirst: async function* () {},
}));

mock.module('../../projects/disk-quota-guard', () => ({
  triggerEmergencyDiskArchiveSweep: () => {},
}));

mock.module('../../shared/platinum', () => ({
  isPlatinumConfigured: () => true,
  platinumJson: async (path: string, init: RequestInit = {}) => {
    if (path.startsWith('/v1/sandboxes?')) {
      const body = JSON.parse(String(init.body)) as { envVars: Record<string, string> };
      deliveredEnv = body.envVars;
      return { id: 'sbx-shim', state: 'running' };
    }
    if (path.includes('/expose')) return { url: 'https://sbx-shim.platinum.test', port: 8000 };
    return {};
  },
}));

mock.module('../service-key', () => ({ serviceKeyForExternalId: async () => 'svc-key' }));
mock.module('../sandbox-frontend-url', () => ({
  sandboxFrontendBaseUrl: () => 'https://app.example.com',
}));

const { DaytonaProvider } = await import('./daytona');
const { E2BProvider } = await import('./e2b');
const { PlatinumProvider } = await import('./platinum');

const CREATE_OPTS = {
  accountId: 'acc-1',
  userId: 'usr-1',
  name: 'session-shim',
  snapshot: 'kortix-snap-shim',
  envVars: SESSION_ENV,
};

const PROVIDERS = [
  { name: 'daytona', create: () => new DaytonaProvider().create({ ...CREATE_OPTS }) },
  { name: 'platinum', create: () => new PlatinumProvider().create({ ...CREATE_OPTS }) },
  { name: 'e2b', create: () => new E2BProvider().create({ ...CREATE_OPTS }) },
] as const;

beforeEach(() => {
  deliveredEnv = undefined;
});

describe('every provider hands the guest a shim-armable environment', () => {
  for (const provider of PROVIDERS) {
    test(`${provider.name}: create() delivers all four shim inputs`, async () => {
      await provider.create();
      const env = deliveredEnv;
      if (!env) throw new Error(`${provider.name} create() delivered no environment`);

      const shim = resolveShimConfig(env);
      expect(shim, provider.name).not.toBeNull();
      expect(shim?.rules).toEqual([{ hosts: ['api.example.com'], identifier: 'billing-api' }]);
      expect(shim?.projectId).toBe('proj-shim');
      // The SESSION credential, never the daemon's own token — the broker route
      // requires a PAT and rejects `kortix_sb_…` outright.
      expect(shim?.token).toBe('kortix_pat_session_credential');
      expect(shim?.apiUrl).toBe(env.KORTIX_API_URL);
    });

    test(`${provider.name}: each of the four is load-bearing, so none may be dropped`, async () => {
      await provider.create();
      const env = deliveredEnv;
      if (!env) throw new Error(`${provider.name} create() delivered no environment`);

      // Proves the case above asserts all four rather than passing on one: with
      // any single name withheld the daemon starts no shim at all.
      for (const name of SHIM_ENV_NAMES) {
        const withheld = { ...env };
        delete withheld[name];
        expect(resolveShimConfig(withheld), `${provider.name} without ${name}`).toBeNull();
      }
    });
  }
});
