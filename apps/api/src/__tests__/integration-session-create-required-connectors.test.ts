import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type Project,
  accountMembers,
  accounts,
  executorConnectors,
  projectMembers,
  projectSessions,
  projects,
} from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { app } from '../index';
import { loadProjectAgents } from '../projects/agents';
import { createProjectSession } from '../projects/lib/sessions';
import { createAccountToken } from '../repositories/account-tokens';
import { db } from '../shared/db';

const ACCOUNT_ID = crypto.randomUUID();
const PROJECT_ID = crypto.randomUUID();
const USER_ID = crypto.randomUUID();
const SESSION_ID = crypto.randomUUID();
const UNAVAILABLE_SESSION_ID = crypto.randomUUID();
const PROJECT_CONNECTOR_ID = crypto.randomUUID();
const USER_CONNECTOR_ID = crypto.randomUUID();

let fixtureRoot = '';
let previousGitCacheDir: string | undefined;
let project: Project;
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
  const [insertedProject] = await db
    .insert(projects)
    .values({
      projectId: PROJECT_ID,
      accountId: ACCOUNT_ID,
      name: `session-connector-gate-${PROJECT_ID}`,
      repoUrl: repository,
    })
    .returning();
  if (!insertedProject) throw new Error('Project fixture insert returned no row');
  project = insertedProject;
  await db.insert(accountMembers).values({
    accountId: ACCOUNT_ID,
    userId: USER_ID,
    accountRole: 'owner',
  });
  await db.insert(projectMembers).values({
    accountId: ACCOUNT_ID,
    projectId: PROJECT_ID,
    userId: USER_ID,
    projectRole: 'manager',
  });
  authToken = (
    await createAccountToken({
      accountId: ACCOUNT_ID,
      userId: USER_ID,
      projectId: PROJECT_ID,
      name: 'required-connector-route-test',
    })
  ).secretKey;

  await db.insert(executorConnectors).values([
    {
      connectorId: PROJECT_CONNECTOR_ID,
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      slug: 'project_records',
      name: 'Project records',
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
      projectId: PROJECT_ID,
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

  await loadProjectAgents(project);
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

describe('createProjectSession required connector authorization gate', () => {
  test('returns every missing authorization and creates no session row', async () => {
    const result = await createProjectSession({
      project,
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
          code: 'CONNECTOR_AUTHORIZATION_REQUIRED',
          message: 'Connect the required connector profiles before starting this session.',
          connector_profiles: [
            {
              id: PROJECT_CONNECTOR_ID,
              slug: 'project_records',
              name: 'Project records',
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
        and(eq(projectSessions.projectId, PROJECT_ID), eq(projectSessions.sessionId, SESSION_ID)),
      );
    expect(rows).toEqual([]);
  });

  test('returns a configuration conflict when a required connector profile is unavailable', async () => {
    const result = await createProjectSession({
      project,
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
          error: 'Required connector profile "unavailable_records" is unavailable',
          code: 'REQUIRED_CONNECTOR_PROFILE_UNAVAILABLE',
          connectors: ['unavailable_records'],
        },
      },
    });

    const rows = await db
      .select({ sessionId: projectSessions.sessionId })
      .from(projectSessions)
      .where(
        and(
          eq(projectSessions.projectId, PROJECT_ID),
          eq(projectSessions.sessionId, UNAVAILABLE_SESSION_ID),
        ),
      );
    expect(rows).toEqual([]);
  });

  test('returns the unavailable profile conflict through the session HTTP route', async () => {
    const sessionId = crypto.randomUUID();
    const response = await app.request(`/v1/projects/${PROJECT_ID}/sessions`, {
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
      error: 'Required connector profile "unavailable_records" is unavailable',
      code: 'REQUIRED_CONNECTOR_PROFILE_UNAVAILABLE',
      connectors: ['unavailable_records'],
    });
    const rows = await db
      .select({ sessionId: projectSessions.sessionId })
      .from(projectSessions)
      .where(
        and(eq(projectSessions.projectId, PROJECT_ID), eq(projectSessions.sessionId, sessionId)),
      );
    expect(rows).toEqual([]);
  });

  test('names every unconfigured alias in one refusal', async () => {
    // One alias per round trip would make a two-connector agent take two failed
    // creates to diagnose, and the caller could never tell how many were left.
    const result = await createProjectSession({
      project,
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
          error: 'Required connector profile "ghost_one", "ghost_two" is unavailable',
          code: 'REQUIRED_CONNECTOR_PROFILE_UNAVAILABLE',
          connectors: ['ghost_one', 'ghost_two'],
        },
      },
    });
  });

  test('an unconfigured alias outranks a merely unauthorized one', async () => {
    // `mixed_failures` requires ghost_one (no connector at all) and
    // project_records (a connector with no authorization). Reporting
    // CONNECTOR_AUTHORIZATION_REQUIRED here would send the end-user into a
    // connect flow while the real blocker is a project the owner has to
    // configure — so the unavailable code has to win.
    const result = await createProjectSession({
      project,
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
          error: 'Required connector profile "ghost_one" is unavailable',
          code: 'REQUIRED_CONNECTOR_PROFILE_UNAVAILABLE',
          connectors: ['ghost_one'],
        },
      },
    });
  });

  test('the refusal status is distinguishable from an unassigned connector', async () => {
    // 403 CONNECTOR_NOT_ASSIGNED is a manifest fault that no amount of
    // connecting fixes; 409 is the state conflict an authorization clears. A
    // client that cannot tell them apart shows the wrong remedy.
    const result = await createProjectSession({
      project,
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
