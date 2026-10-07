import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

// The revoked-token error contract, black-box: a real CLI process against a
// real local API.
//
// KRTX-1564: after a project CLI token is revoked, the next call with it must
// name THAT token. Two defects hid it:
//   - the API answered a kind-blind `PAT not found or revoked`, so no surface
//     could name the dead row;
//   - the CLI printed a bare `Token rejected.` and its denial footer resolved
//     the ACTIVE host's identity — inside a sandbox that is the injected
//     session token, i.e. an unrelated credential the caller never passed.
//
// The harness mirrors the dogfood journey: two hosts in one config. `test` is
// the active host holding a session credential (the sandbox stand-in); `dev2`
// holds the project CLI token the calls are refused on. The footer must name
// the refused credential or nothing — never the active host's.
//
// The end-to-end behaviour against real Postgres is covered by
// apps/api/src/__tests__/integration-revoked-token-auth.test.ts (db-suites).

const CLI_ENTRY = resolve(import.meta.dir, '..', 'index.ts');

const SESSION_TOKEN = 'kortix_pat_session_identity';
const PROJECT_TOKEN = 'kortix_pat_project_cli_token';
const PROJECT_ID = 'cccccccc-3333-4333-8333-333333333333';
const DEAD_TOKEN_ID = 'dddddddd-4444-4444-8444-444444444444';
const REVOKED_MESSAGE = `project token ${DEAD_TOKEN_ID} is revoked`;

const SESSION_ME = {
  user_id: '11111111-1111-4111-8111-111111111111',
  email: 'agent@example.test',
  token_context: {
    auth_type: 'pat',
    project_id: PROJECT_ID,
    session_id: 'sess-7777',
    agent: 'builder',
    kortix_permissions: ['project.session.read'],
  },
  accounts: [
    { account_id: 'aaaaaaaa-1111-4111-8111-111111111111', slug: 'acme', name: 'Acme', role: 'owner' },
  ],
};

const PROJECT_ME = {
  user_id: '11111111-1111-4111-8111-111111111111',
  email: 'owner@example.test',
  token_context: {
    auth_type: 'pat',
    project_id: PROJECT_ID,
    session_id: null,
    agent: null,
    kortix_permissions: ['project.session.read'],
  },
  accounts: [
    { account_id: 'aaaaaaaa-1111-4111-8111-111111111111', slug: 'acme', name: 'Acme', role: 'owner' },
  ],
};

/** The typed dead-credential 401 the API's deadCredential401 builds. */
const revoked401 = () =>
  Response.json(
    { error: true, message: REVOKED_MESSAGE, status: 401, code: 'session_token_revoked' },
    { status: 401 },
  );

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

let server: ReturnType<typeof Bun.serve> | null = null;
let apiPort = 0;
/** Flipped after the warm-up call — the token "gets revoked" mid-suite. */
let revoked = false;

function startApi(): void {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const bearer = req.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
      if (bearer === PROJECT_TOKEN) {
        if (revoked) return revoked401();
        if (new URL(req.url).pathname.endsWith('/accounts/me')) {
          return Response.json(PROJECT_ME);
        }
        return Response.json({ items: [] });
      }
      if (bearer === SESSION_TOKEN && new URL(req.url).pathname.endsWith('/accounts/me')) {
        return Response.json(SESSION_ME);
      }
      return Response.json({ error: 'unauthenticated' }, { status: 401 });
    },
  });
  apiPort = server.port ?? 0;
}

/** One throwaway HOME for the whole suite: the warm-up call must leave the
 *  token-identity cache behind for the revoked-phase footer to find. */
const dir = mkdtempSync(join(tmpdir(), 'kortix-token-rejected-'));
const config = join(dir, 'config.json');

function seedConfig(): void {
  writeFileSync(
    config,
    JSON.stringify({
      active: 'test',
      hosts: {
        test: {
          url: `http://127.0.0.1:${apiPort}/v1`,
          token: SESSION_TOKEN,
          user_id: SESSION_ME.user_id,
          user_email: SESSION_ME.email,
          account_id: SESSION_ME.accounts[0].account_id,
          logged_in_at: '2026-01-01T00:00:00.000Z',
        },
        dev2: {
          url: `http://127.0.0.1:${apiPort}/v1`,
          token: PROJECT_TOKEN,
          user_id: PROJECT_ME.user_id,
          user_email: PROJECT_ME.email,
          account_id: PROJECT_ME.accounts[0].account_id,
          logged_in_at: '2026-01-01T00:00:00.000Z',
        },
      },
    }),
  );
}

function childEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: dir,
    KORTIX_CONFIG_FILE: config,
    KORTIX_NO_UPDATE_CHECK: '1',
    KORTIX_DISABLE_SANDBOX_ENV_FILE: '1',
    NO_COLOR: '1',
    FORCE_COLOR: '0',
  };
  for (const key of ['KORTIX_API_URL', 'KORTIX_TOKEN', 'KORTIX_PROJECT_ID', 'KORTIX_SESSION_ID']) {
    delete env[key];
  }
  return env;
}

async function runCli(args: string[]): Promise<CliResult> {
  const proc = Bun.spawn({
    cmd: [process.execPath, CLI_ENTRY, ...args],
    cwd: dir,
    env: childEnv(),
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timeout = setTimeout(() => proc.kill(), 30_000);
  try {
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timeout);
  }
}

let warm: CliResult;
let whoamiRevoked: CliResult;
let marketplaceRevoked: CliResult;

beforeAll(async () => {
  startApi();
  seedConfig();
  // Warm-up: the project token works, so the token-identity cache learns it —
  // exactly one real CLI use before the revocation, as the journey runs.
  warm = await runCli(['whoami', '--host', 'dev2', '--json']);
  revoked = true;
  // Run the revoked-phase probes serially: the stub flag is global.
  whoamiRevoked = await runCli(['whoami', '--host', 'dev2', '--json']);
  marketplaceRevoked = await runCli(['marketplace', 'list', '--host', 'dev2']);
}, 120_000);

afterAll(() => {
  server?.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

describe('a revoked token is named by the error the CLI surfaces', () => {
  test('warm-up: the project token authenticates before the revocation', () => {
    expect(warm.code).toBe(0);
    expect(JSON.parse(warm.stdout).user_email).toBe(PROJECT_ME.email);
  });

  test('whoami: the 401 line names the revoked project token', () => {
    expect(whoamiRevoked.code).toBe(1);
    expect(whoamiRevoked.stderr).toContain(`Token rejected — ${REVOKED_MESSAGE}`);
    expect(whoamiRevoked.stderr).toContain('kortix login');
  });

  test('surfaceApiError: the 401 line names the revoked token and the footer names the refused credential, never the active host', () => {
    expect(marketplaceRevoked.code).toBe(1);
    expect(marketplaceRevoked.stderr).toContain(`Token rejected — ${REVOKED_MESSAGE}`);
    // The footer must speak about the credential the request carried. The
    // active host holds a session credential — naming it here is the reported
    // bug: the customer goes looking at an unrelated session-token row.
    expect(marketplaceRevoked.stderr).not.toContain('acting as session token');
    expect(marketplaceRevoked.stderr).toContain('acting as project token');
    expect(marketplaceRevoked.stderr).toContain('project token');
  });
});
