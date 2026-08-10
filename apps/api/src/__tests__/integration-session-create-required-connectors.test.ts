import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type Workspace,
  accountMembers,
  accounts,
  connectors,
  projectMembers,
  projectSessions,
  projects,
} from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { app } from '../index';
import { loadWorkspaceAgents } from '../workspaces/agents';
import { createWorkspaceSession } from '../workspaces/lib/sessions';
import { createAccountToken } from '../repositories/account-tokens';
import { db } from '../shared/db';

const ACCOUNT_ID = crypto.randomUUID();
const WORKSPACE_ID = crypto.randomUUID();
const USER_ID = crypto.randomUUID();
const SESSION_ID = crypto.randomUUID();
const UNAVAILABLE_SESSION_ID = crypto.randomUUID();
const READ_WORKSPACE_SESSION_ID = crypto.randomUUID();
const WORKSPACE_CONNECTOR_ID = crypto.randomUUID();
const USER_CONNECTOR_ID = crypto.randomUUID();

let fixtureRoot = '';
let previousGitCacheDir: string | undefined;
let workspace: Workspace;
let authToken = '';

function git(args: string[], cwd: string): void {
  execFileSync('git', args, {
    cwd,
    stdio: 'pipe',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
}

beforeAll(async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), 'kortix-session-connector-gate-'));
  previousGitCacheDir = process.env.KORTIX_GIT_CACHE_DIR;
  process.env.KORTIX_GIT_CACHE_DIR = join(fixtureRoot, 'git-cache');

  const repository = join(fixtureRoot, 'repository');
  mkdirSync(repository, { recursive: true });
  git(['init', '-b', 'main'], repository);
  git(['config', 'user.email', 'session-gate@kortix.test'], repository);
  git(['config', 'user.name', 'Session Gate Test'], repository);
  writeFileSync(join(repository, 'README.md'), '# Session connector gate\n', 'utf8');
  writeFileSync(
    join(repository, 'kortix.yaml'),
    [
      'kortix_version: 2',
      'default_agent: support',
      'agents:',
      '  support:',
      '    connectors: [project_records, user_records]',
      '  unavailable:',
      '    connectors: [unavailable_records]',
      '    connectors_required: [unavailable_records]',
      '',
    ].join('\n'),
    'utf8',
  );
  git(['add', 'README.md', 'kortix.yaml'], repository);
  git(['commit', '-m', 'initial'], repository);

  await db.insert(accounts).values({
    accountId: ACCOUNT_ID,
    name: `session-connector-gate-${ACCOUNT_ID}`,
  });
  const [insertedWorkspace] = await db
    .insert(projects)
    .values({
      workspaceId: WORKSPACE_ID,
      accountId: ACCOUNT_ID,
      name: `session-connector-gate-${WORKSPACE_ID}`,
      repoUrl: repository,
    })
    .returning();
  if (!insertedWorkspace) throw new Error('Workspace fixture insert returned no row');
  workspace = insertedWorkspace;
  await db.insert(accountMembers).values({
    accountId: ACCOUNT_ID,
    userId: USER_ID,
    accountRole: 'owner',
  });
  await db.insert(projectMembers).values({
    accountId: ACCOUNT_ID,
    workspaceId: WORKSPACE_ID,
    userId: USER_ID,
    projectRole: 'manager',
  });
  authToken = (
    await createAccountToken({
      accountId: ACCOUNT_ID,
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
      name: 'required-connector-route-test',
    })
  ).secretKey;

  await db.insert(connectors).values([
    {
      connectorId: WORKSPACE_CONNECTOR_ID,
      accountId: ACCOUNT_ID,
      workspaceId: WORKSPACE_ID,
      slug: 'project_records',
      name: 'Workspace records',
      providerType: 'http',
      config: {
        baseUrl: 'https://project-records.example.test',
        auth: { type: 'bearer' },
      },
      authorizationStrategy: 'project',
    },
    {
      connectorId: USER_CONNECTOR_ID,
      accountId: ACCOUNT_ID,
      workspaceId: WORKSPACE_ID,
      slug: 'user_records',
      name: 'User records',
      providerType: 'http',
      config: {
        baseUrl: 'https://user-records.example.test',
        auth: { type: 'bearer' },
      },
      authorizationStrategy: 'user',
    },
  ]);

  await loadWorkspaceAgents(workspace);
  writeFileSync(
    join(repository, 'kortix.yaml'),
    [
      'kortix_version: 2',
      'default_agent: support',
      'agents:',
      '  support:',
      '    connectors: [project_records, user_records]',
      '    connectors_required: [project_records, user_records]',
      '  unavailable:',
      '    connectors: [unavailable_records]',
      '    connectors_required: [unavailable_records]',
      '  two_unavailable:',
      '    connectors: [ghost_one, ghost_two]',
      '    connectors_required: [ghost_one, ghost_two]',
      '  mixed_failures:',
      '    connectors: [ghost_one, project_records]',
      '    connectors_required: [ghost_one, project_records]',
      '  restricted_reader:',
      '    workspace: read',
      '',
    ].join('\n'),
    'utf8',
  );
  git(['add', 'kortix.yaml'], repository);
  git(['commit', '-m', 'require connectors'], repository);
});

afterAll(async () => {
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT_ID));
  if (previousGitCacheDir === undefined) delete process.env.KORTIX_GIT_CACHE_DIR;
  else process.env.KORTIX_GIT_CACHE_DIR = previousGitCacheDir;
  if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
});

describe('createWorkspaceSession required connection gate', () => {
  test('rejects read mode before creating a session row', async () => {
    const result = await createWorkspaceSession({
      workspace,
      userId: USER_ID,
      requestingPrincipalType: 'human',
      body: {
        session_id: READ_WORKSPACE_SESSION_ID,
        agent_name: 'restricted_reader',
      },
      enforceAccountCap: false,
      authType: 'supabase',
    });

    expect(result).toEqual({
      error: {
        status: 409,
        body: {
          error: 'workspace mode "read" requires restricted workspace artifacts',
          code: 'WORKSPACE_MODE_UNAVAILABLE',
        },
      },
    });

    const rows = await db
      .select({ sessionId: projectSessions.sessionId })
      .from(projectSessions)
      .where(
        and(
          eq(projectSessions.workspaceId, WORKSPACE_ID),
          eq(projectSessions.sessionId, READ_WORKSPACE_SESSION_ID),
        ),
      );
    expect(rows).toEqual([]);
  });

  test('returns the read-mode refusal through the session HTTP route', async () => {
    const sessionId = crypto.randomUUID();
    const response = await app.request(`/v1/projects/${WORKSPACE_ID}/sessions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${authToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        session_id: sessionId,
        agent_name: 'restricted_reader',
      }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'workspace mode "read" requires restricted workspace artifacts',
      code: 'WORKSPACE_MODE_UNAVAILABLE',
    });
    const rows = await db
      .select({ sessionId: projectSessions.sessionId })
      .from(projectSessions)
      .where(
        and(eq(projectSessions.workspaceId, WORKSPACE_ID), eq(projectSessions.sessionId, sessionId)),
      );
    expect(rows).toEqual([]);
  });

  test('returns every missing connection and creates no session row', async () => {
    const result = await createWorkspaceSession({
      workspace,
      userId: USER_ID,
      requestingPrincipalType: 'human',
      body: {
        session_id: SESSION_ID,
        require_connectors: ['project_records'],
      },
      enforceAccountCap: false,
      authType: 'supabase',
    });

    expect(result).toEqual({
      error: {
        status: 409,
        body: {
          code: 'CONNECTOR_CONNECTION_REQUIRED',
          message: 'Create the required connections before starting this session.',
          connector_connections: [
            {
              id: WORKSPACE_CONNECTOR_ID,
              slug: 'project_records',
              name: 'Workspace records',
              authorization_strategy: 'project',
            },
            {
              id: USER_CONNECTOR_ID,
              slug: 'user_records',
              name: 'User records',
              authorization_strategy: 'user',
            },
          ],
        },
      },
    });

    const rows = await db
      .select({ sessionId: projectSessions.sessionId })
      .from(projectSessions)
      .where(
        and(eq(projectSessions.workspaceId, WORKSPACE_ID), eq(projectSessions.sessionId, SESSION_ID)),
      );
    expect(rows).toEqual([]);
  });

  test('returns a configuration conflict when a required connection is unavailable', async () => {
    const result = await createWorkspaceSession({
      workspace,
      userId: USER_ID,
      requestingPrincipalType: 'human',
      body: {
        session_id: UNAVAILABLE_SESSION_ID,
        agent_name: 'unavailable',
      },
      enforceAccountCap: false,
      authType: 'supabase',
    });

    expect(result).toEqual({
      error: {
        status: 409,
        body: {
          error: 'Required connection "unavailable_records" is unavailable',
          code: 'REQUIRED_CONNECTOR_CONNECTION_UNAVAILABLE',
          connectors: ['unavailable_records'],
        },
      },
    });

    const rows = await db
      .select({ sessionId: projectSessions.sessionId })
      .from(projectSessions)
      .where(
        and(
          eq(projectSessions.workspaceId, WORKSPACE_ID),
          eq(projectSessions.sessionId, UNAVAILABLE_SESSION_ID),
        ),
      );
    expect(rows).toEqual([]);
  });

  test('returns the unavailable connection conflict through the session HTTP route', async () => {
    const sessionId = crypto.randomUUID();
    const response = await app.request(`/v1/projects/${WORKSPACE_ID}/sessions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${authToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        session_id: sessionId,
        agent_name: 'unavailable',
      }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'Required connection "unavailable_records" is unavailable',
      code: 'REQUIRED_CONNECTOR_CONNECTION_UNAVAILABLE',
      connectors: ['unavailable_records'],
    });
    const rows = await db
      .select({ sessionId: projectSessions.sessionId })
      .from(projectSessions)
      .where(
        and(eq(projectSessions.workspaceId, WORKSPACE_ID), eq(projectSessions.sessionId, sessionId)),
      );
    expect(rows).toEqual([]);
  });

  test('names every unconfigured alias in one refusal', async () => {
    // One alias per round trip would make a two-connector agent take two failed
    // creates to diagnose, and the caller could never tell how many were left.
    const result = await createWorkspaceSession({
      workspace,
      userId: USER_ID,
      requestingPrincipalType: 'human',
      body: { session_id: crypto.randomUUID(), agent_name: 'two_unavailable' },
      enforceAccountCap: false,
      authType: 'supabase',
    });

    expect(result).toEqual({
      error: {
        status: 409,
        body: {
          error: 'Required connections "ghost_one", "ghost_two" are unavailable',
          code: 'REQUIRED_CONNECTOR_CONNECTION_UNAVAILABLE',
          connectors: ['ghost_one', 'ghost_two'],
        },
      },
    });
  });

  test('an unconfigured alias outranks a merely unauthorized one', async () => {
    // `mixed_failures` requires ghost_one (no connector at all) and
    // project_records (a connector with no connection). Reporting
    // CONNECTOR_CONNECTION_REQUIRED here would send the end-user into a
    // connect flow while the real blocker is a project the owner has to
    // configure — so the unavailable code has to win.
    const result = await createWorkspaceSession({
      workspace,
      userId: USER_ID,
      requestingPrincipalType: 'human',
      body: { session_id: crypto.randomUUID(), agent_name: 'mixed_failures' },
      enforceAccountCap: false,
      authType: 'supabase',
    });

    expect(result).toEqual({
      error: {
        status: 409,
        body: {
          error: 'Required connection "ghost_one" is unavailable',
          code: 'REQUIRED_CONNECTOR_CONNECTION_UNAVAILABLE',
          connectors: ['ghost_one'],
        },
      },
    });
  });

  test('the refusal status is distinguishable from an unassigned connector', async () => {
    // 403 CONNECTOR_NOT_ASSIGNED is a manifest fault that no amount of
    // connecting fixes; 409 is the state conflict a connection clears. A
    // client that cannot tell them apart shows the wrong remedy.
    const result = await createWorkspaceSession({
      workspace,
      userId: USER_ID,
      requestingPrincipalType: 'human',
      body: {
        session_id: crypto.randomUUID(),
        agent_name: 'unavailable',
        require_connectors: ['project_records'],
      },
      enforceAccountCap: false,
      authType: 'supabase',
    });

    expect(result).toEqual({
      error: {
        status: 403,
        body: {
          error: 'Agent "unavailable" is not granted connector "project_records"',
          code: 'CONNECTOR_NOT_ASSIGNED',
        },
      },
    });
  });
});
