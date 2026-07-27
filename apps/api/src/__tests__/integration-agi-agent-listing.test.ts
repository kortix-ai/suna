/**
 * Real-DB integration over the mounted app: the platform AGI is a LISTED,
 * SELECTABLE agent (R-34/R-35/R-37/R-44).
 *
 * `GET /v1/projects/:projectId/detail` is the one endpoint the web agent
 * chooser reads (`getProjectDetail` → `config.agents` →
 * `projectConfigAgentsToOpenCodeAgents` → `useVisibleAgents`), so it is the one
 * endpoint asserted here. The git reads are the only thing stubbed — the
 * manifest parser, the agent extractor, the per-resource filter, the capability
 * filter, the experimental gate and the authz prelude are all real.
 *
 * The last block is the reason this file exists at all: a picker that offers an
 * agent which 500s on select is worse than no picker, so it drives the SAME
 * create call the picker will make. Sandbox provisioning is stubbed (the create
 * response is returned before it, fire-and-forget) so no real box is booted.
 *
 * The `integration-` filename prefix is load-bearing: scripts/test.sh's default
 * bucket excludes it, because that bucket runs without a database. Run this with:
 *   KORTIX_URL=http://localhost:8008 dotenvx run --quiet -- \
 *     bun test src/__tests__/integration-agi-agent-listing.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';

// Session create refuses (503 KORTIX_URL_UNREACHABLE) when KORTIX_URL is a
// loopback address, because a cloud sandbox could never call back to it. The
// documented way to run this suite exports exactly such a URL, so pin a public
// one here — BEFORE the first import, since `config` freezes it at load — or
// every create below would fail for a reason that has nothing to do with agents.
const ORIGINAL_KORTIX_URL = process.env.KORTIX_URL;
process.env.KORTIX_URL = 'https://api.test.kortix.local';

/** Swapped per test — "what the repo looks like right now". */
let manifestFile: { path: string; content: string } | null = null;
let repoFiles: Array<{ path: string; type: 'file'; size: number | null }> = [];
let repoFileContents: Record<string, string> = {};

// Spread-and-override, never replace: these are heavily-imported modules and the
// rest of the app's import graph needs their other named exports intact.
// `git/files` (not the `git` barrel) is the seam: `loadProjectConfig` imports
// from it directly, so mocking the barrel alone would leave the config loader
// talking to a real git mirror.
const realGitFiles = await import('../projects/git/files');
mock.module('../projects/git/files', () => ({
  ...realGitFiles,
  listRepoFiles: async () => repoFiles,
  readManifestFromRepo: async (_project: unknown, candidates: string[]) =>
    manifestFile && candidates.includes(manifestFile.path) ? manifestFile : null,
  readRepoFile: async (_project: unknown, path: string) => {
    const content = repoFileContents[path];
    if (content === undefined) throw new Error(`fatal: path '${path}' does not exist`);
    return content;
  },
}));

const realProjectsGit = await import('../projects/git');
mock.module('../projects/git', () => ({
  ...realProjectsGit,
  // Session create publishes the session branch in the background; there is no
  // remote here.
  createRemoteSessionBranch: async () => undefined,
  resolveCommitSha: async () => undefined,
}));

const realLibGit = await import('../projects/lib/git');
mock.module('../projects/lib/git', () => ({
  ...realLibGit,
  withProjectGitAuth: async (project: unknown) => ({
    ...(project as Record<string, unknown>),
    gitAuthToken: null,
    gitAuthHeaders: {},
  }),
}));

/**
 * Hard stop on the one call that would cost a real sandbox. It throws rather
 * than resolves so nothing downstream runs on a half-built sandbox record; the
 * create response is already returned by then (provisioning is fire-and-forget),
 * so the "Failed to kick off sandbox" lines this produces are the stub working.
 */
const realSessionSandbox = await import('../platform/services/session-sandbox');
mock.module('../platform/services/session-sandbox', () => ({
  ...realSessionSandbox,
  provisionSessionSandbox: async () => {
    throw new Error('sandbox provisioning is stubbed in integration-agi-agent-listing');
  },
}));

const { eq, inArray, sql } = await import('drizzle-orm');
const { accountMembers, accounts, projectMembers, projects, projectSessions } = await import(
  '@kortix/db'
);
const { db } = await import('../shared/db');
const { app } = await import('../index');
const { createAccountToken } = await import('../repositories/account-tokens');
const { AGI_AGENT_NAME } = await import('../projects/agents');
const { AGI_AGENT_PATH } = await import('../projects/lib/platform-agents');

const ACCOUNT = crypto.randomUUID();
const WORKSPACE = crypto.randomUUID();
const WORKSPACE_OFF = crypto.randomUUID();
const OWNER = crypto.randomUUID();

const minted: string[] = [];
let ownerToken = '';

/** A v2 manifest that declares an agent named exactly like the platform AGI,
 *  scoped to nothing and pointed at its own behavior file — the shadowing
 *  attempt R-35 forbids. `helper` is the control: an ordinary declared agent
 *  that must survive the composition untouched. */
const SHADOWING_MANIFEST = `kortix_version: 2

default_agent: helper

agents:
  helper: {}
  ${AGI_AGENT_NAME}:
    description: totally normal helper
    secrets: []
    connectors: []
    kortix_cli: []
`;

const PLAIN_MANIFEST = `kortix_version: 2

default_agent: helper

agents:
  helper: {}
`;

beforeAll(async () => {
  await db.execute(
    sql`alter table kortix.account_tokens add column if not exists agent_grant jsonb`,
  );
  await db.execute(sql`alter table kortix.account_tokens add column if not exists session_id text`);
  await db.execute(
    sql`alter table kortix.account_tokens add column if not exists service_account_id uuid`,
  );

  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'agi-agent-listing-test' });
  await db.insert(projects).values([
    {
      projectId: WORKSPACE,
      accountId: ACCOUNT,
      name: 'agi-agent-listing-workspace',
      repoUrl: 'https://example.com/agi-agent-listing.git',
      manifestPath: 'kortix.yaml',
      metadata: { experimental: { agi: true } },
    },
    {
      projectId: WORKSPACE_OFF,
      accountId: ACCOUNT,
      name: 'agi-agent-listing-workspace-off',
      repoUrl: 'https://example.com/agi-agent-listing-off.git',
      manifestPath: 'kortix.yaml',
    },
  ]);
  await db
    .insert(accountMembers)
    .values({ userId: OWNER, accountId: ACCOUNT, accountRole: 'owner', isSuperAdmin: false });
  await db.insert(projectMembers).values(
    [WORKSPACE, WORKSPACE_OFF].map((projectId) => ({
      accountId: ACCOUNT,
      projectId,
      userId: OWNER,
      projectRole: 'manager' as const,
    })),
  );

  const token = await createAccountToken({
    accountId: ACCOUNT,
    userId: OWNER,
    name: 'agi-agent-listing-test',
  });
  minted.push(token.tokenId);
  ownerToken = token.secretKey;
});

afterAll(async () => {
  await db
    .delete(projectSessions)
    .where(inArray(projectSessions.projectId, [WORKSPACE, WORKSPACE_OFF]));
  for (const tokenId of minted) {
    await db.execute(sql`delete from kortix.account_tokens where token_id = ${tokenId}`);
  }
  await db.delete(projects).where(eq(projects.accountId, ACCOUNT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
  if (ORIGINAL_KORTIX_URL === undefined) delete process.env.KORTIX_URL;
  else process.env.KORTIX_URL = ORIGINAL_KORTIX_URL;
});

beforeEach(() => {
  manifestFile = { path: 'kortix.yaml', content: PLAIN_MANIFEST };
  repoFiles = [];
  repoFileContents = {};
});

function req(method: string, path: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: {
      Authorization: `Bearer ${ownerToken}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

/** The wire shape of one `config.agents` entry, restated here so the assertions
 *  below fail on a field RENAME rather than silently reading `undefined`. */
interface ListedAgent {
  name: string;
  path: string;
  description: string | null;
  mode: string | null;
  source?: string;
  enabled?: boolean;
  platform_owned?: boolean;
  scope?: unknown;
}

async function agentsOf(workspace: string): Promise<ListedAgent[]> {
  const res = await req('GET', `/v1/projects/${workspace}/detail`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { config: { agents: ListedAgent[] } };
  return body.config.agents;
}

const nameOf = (agents: ListedAgent[]) => agents.map((a) => a.name);

describe('GET /detail — the AGI is listed when `agi` is on (R-34/R-37)', () => {
  test('present, elevated FIRST, and flagged platform-owned', async () => {
    const agents = await agentsOf(WORKSPACE);

    expect(nameOf(agents)).toEqual([AGI_AGENT_NAME, 'helper']);
    const agi = agents[0];
    expect(agi.platform_owned).toBe(true);
    expect(agi.source).toBe('platform');
    expect(agi.enabled).toBe(true);
    expect(agi.mode).toBe('primary');
    expect(agi.path).toBe(AGI_AGENT_PATH);
  });

  test('carries a description a picker can show a user', async () => {
    const [agi] = await agentsOf(WORKSPACE);

    const description = agi.description ?? '';
    expect(description.length).toBeGreaterThan(40);
    expect(description.toLowerCase()).toContain('session');
  });

  test('a client can find it WITHOUT string-matching the name', async () => {
    const agents = await agentsOf(WORKSPACE);
    const elevated = agents.filter((a) => a.platform_owned === true);

    expect(elevated).toHaveLength(1);
    expect(elevated[0].name).toBe(AGI_AGENT_NAME);
    // …and the workspace's own agents are unambiguously not elevated.
    expect(agents.filter((a) => a.platform_owned !== true).map((a) => a.name)).toEqual(['helper']);
  });

  test('present even when the project declares no agents at all (R-35)', async () => {
    manifestFile = null;
    const agents = await agentsOf(WORKSPACE);

    expect(nameOf(agents)).toEqual([AGI_AGENT_NAME]);
  });

  test('present even when the project has no manifest and no repo files', async () => {
    manifestFile = null;
    repoFiles = [{ path: 'README.md', type: 'file', size: 12 }];
    repoFileContents = { 'README.md': 'hello world\n' };

    expect(nameOf(await agentsOf(WORKSPACE))).toEqual([AGI_AGENT_NAME]);
  });

  test('does not displace OpenCode-discovered agents', async () => {
    manifestFile = null;
    repoFiles = [{ path: '.kortix/opencode/agents/scout.md', type: 'file', size: 40 }];
    repoFileContents = {
      '.kortix/opencode/agents/scout.md': '---\ndescription: scouts\nmode: primary\n---\n\nhi\n',
    };

    const agents = await agentsOf(WORKSPACE);
    expect(nameOf(agents)).toEqual([AGI_AGENT_NAME, 'scout']);
    expect(agents[1].source).toBe('opencode');
  });
});

describe('GET /detail — the AGI is absent when `agi` is off (R-44)', () => {
  test('a workspace without the flag lists only its own agents', async () => {
    const agents = await agentsOf(WORKSPACE_OFF);

    expect(nameOf(agents)).toEqual(['helper']);
    expect(agents.some((a) => a.platform_owned === true)).toBe(false);
  });

  test('absent even when the workspace declares the reserved name itself', async () => {
    manifestFile = { path: 'kortix.yaml', content: SHADOWING_MANIFEST };
    const agents = await agentsOf(WORKSPACE_OFF);

    expect(nameOf(agents)).toEqual(['helper']);
  });
});

describe('GET /detail — a manifest cannot shadow the platform AGI (R-35)', () => {
  beforeEach(() => {
    manifestFile = { path: 'kortix.yaml', content: SHADOWING_MANIFEST };
  });

  test('exactly one entry by that name, and it is the platform one', async () => {
    const agents = await agentsOf(WORKSPACE);
    const matches = agents.filter((a) => a.name === AGI_AGENT_NAME);

    expect(matches).toHaveLength(1);
    expect(matches[0].platform_owned).toBe(true);
    expect(matches[0].source).toBe('platform');
  });

  test('the declared narrowing never surfaces', async () => {
    const [agi] = await agentsOf(WORKSPACE);

    // A `scope` block would tell the UI this agent is scoped to nothing —
    // authority the manifest does not actually have over it.
    expect(agi.scope).toBeUndefined();
    expect(agi.description).not.toBe('totally normal helper');
  });

  test('the workspace keeps its own agents alongside it', async () => {
    expect(nameOf(await agentsOf(WORKSPACE))).toEqual([AGI_AGENT_NAME, 'helper']);
  });
});

describe('POST /sessions — selecting the AGI from the picker works', () => {
  async function createSessionAs(workspace: string, agentName: string) {
    const res = await req('POST', `/v1/projects/${workspace}/sessions`, { agent_name: agentName });
    const body = (await res.json()) as { agent_name?: string; session_id?: string; code?: string };
    return { status: res.status, body };
  }

  test('a session naming the listed AGI is created (no 4xx/5xx)', async () => {
    const { status, body } = await createSessionAs(WORKSPACE, AGI_AGENT_NAME);

    expect(status).toBe(201);
    expect(body.agent_name).toBe(AGI_AGENT_NAME);
    expect(body.session_id).toBeTruthy();
  });

  test('the name the picker reads is the name create accepts', async () => {
    const [agi] = await agentsOf(WORKSPACE);
    const { status, body } = await createSessionAs(WORKSPACE, agi.name);

    expect(status).toBe(201);
    expect(body.agent_name).toBe(agi.name);
  });

  test('a shadowing manifest entry does not break the create', async () => {
    manifestFile = { path: 'kortix.yaml', content: SHADOWING_MANIFEST };
    const { status, body } = await createSessionAs(WORKSPACE, AGI_AGENT_NAME);

    expect(status).toBe(201);
    expect(body.agent_name).toBe(AGI_AGENT_NAME);
  });

  test('mandatory-declared-agents does not reject it', async () => {
    // The gate that 400s an UNLISTED name. The AGI is declared by the platform,
    // so it must pass without a manifest entry — the property that makes it
    // safe to offer in a picker for a locked-down workspace.
    await db
      .update(projects)
      .set({ metadata: { experimental: { agi: true }, require_declared_agents: true } })
      .where(eq(projects.projectId, WORKSPACE));
    try {
      const { status, body } = await createSessionAs(WORKSPACE, AGI_AGENT_NAME);
      expect(status).toBe(201);
      expect(body.agent_name).toBe(AGI_AGENT_NAME);

      // Control: an undeclared ordinary name IS rejected, so the test above is
      // not passing because enforcement silently failed to engage.
      const undeclared = await createSessionAs(WORKSPACE, 'nope-not-declared');
      expect(undeclared.status).toBe(400);
      expect(undeclared.body.code).toBe('AGENT_NOT_DECLARED');
    } finally {
      await db
        .update(projects)
        .set({ metadata: { experimental: { agi: true } } })
        .where(eq(projects.projectId, WORKSPACE));
    }
  });
});
