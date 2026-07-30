import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  accounts,
  executorConnectors,
  projectSessions,
  projects,
  type Project,
} from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { createProjectSession } from '../projects/lib/sessions';
import { db } from '../shared/db';

const ACCOUNT_ID = crypto.randomUUID();
const PROJECT_ID = crypto.randomUUID();
const USER_ID = crypto.randomUUID();
const SESSION_ID = crypto.randomUUID();
const PROJECT_CONNECTOR_ID = crypto.randomUUID();
const USER_CONNECTOR_ID = crypto.randomUUID();

let fixtureRoot = '';
let previousGitCacheDir: string | undefined;
let project: Project;

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
      '    connectors_required: [project_records, user_records]',
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
        and(
          eq(projectSessions.projectId, PROJECT_ID),
          eq(projectSessions.sessionId, SESSION_ID),
        ),
      );
    expect(rows).toEqual([]);
  });
});
