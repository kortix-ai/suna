import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { eq, inArray } from 'drizzle-orm';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createDb,
  accountInvitations,
  accountMembers,
  accounts,
  legacySandboxMigrations,
  projectSessions,
  projects,
  sandboxInvites,
  sandboxMembers,
  sandboxes,
  sessionSandboxes,
  type Database,
} from '@kortix/db';
import { renderLegacyRepoUrl, runLegacySandboxMigration } from '../projects/legacy-migration';

const TEST_DB_CONFIRMATION = 'I_UNDERSTAND_THIS_DELETES_TEST_DATA';
const HAS_CONFIRMED_TEST_DB = Boolean(
  process.env.TEST_DATABASE_URL &&
  process.env.KORTIX_TEST_DB_CONFIRM === TEST_DB_CONFIRMATION &&
  process.env.INTERNAL_KORTIX_ENV !== 'prod',
);
const describeWithDb = HAS_CONFIRMED_TEST_DB ? describe : describe.skip;

const ACCOUNT_ID = '00000000-0000-4000-a000-000000009101';
const MEMBER_ID = '00000000-0000-4000-a000-000000009102';
const SANDBOX_ID = '00000000-0000-4000-a000-000000009201';
const RUN_ID = 'legacy-migration-test-run';
const CLI_RUN_ID = 'legacy-migration-cli-test-run';
const REPO_TEMPLATE = 'https://github.com/kortix-migrations/{slug}-{sandbox_id}.git';
const API_PACKAGE_DIR = fileURLToPath(new URL('../..', import.meta.url));

let testDb: Database | null = null;

function getTestDb(): Database {
  if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required');
  if (!testDb) testDb = createDb(process.env.TEST_DATABASE_URL, { max: 1 });
  return testDb;
}

async function cleanup() {
  const db = getTestDb();
  const [migration] = await db
    .select()
    .from(legacySandboxMigrations)
    .where(eq(legacySandboxMigrations.sandboxId, SANDBOX_ID))
    .limit(1);
  const projectIds = migration?.projectId ? [migration.projectId] : [];
  const sessionIds = migration?.sessionId ? [migration.sessionId] : [SANDBOX_ID];

  await db.delete(legacySandboxMigrations).where(eq(legacySandboxMigrations.sandboxId, SANDBOX_ID));
  await db.delete(sessionSandboxes).where(eq(sessionSandboxes.sandboxId, SANDBOX_ID));
  await db.delete(projectSessions).where(inArray(projectSessions.sessionId, sessionIds));
  if (projectIds.length > 0) await db.delete(projects).where(inArray(projects.projectId, projectIds));
  await db.delete(accountInvitations).where(eq(accountInvitations.accountId, ACCOUNT_ID));
  await db.delete(accountMembers).where(eq(accountMembers.accountId, ACCOUNT_ID));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT_ID));
  await db.delete(sandboxInvites).where(eq(sandboxInvites.sandboxId, SANDBOX_ID));
  await db.delete(sandboxMembers).where(eq(sandboxMembers.sandboxId, SANDBOX_ID));
  await db.delete(sandboxes).where(eq(sandboxes.sandboxId, SANDBOX_ID));
}

async function seedLegacySandbox() {
  const db = getTestDb();
  await db.insert(sandboxes).values({
    sandboxId: SANDBOX_ID,
    accountId: ACCOUNT_ID,
    name: 'Legacy Workspace',
    provider: 'local_docker',
    externalId: 'legacy-container-1',
    status: 'active',
    baseUrl: 'http://127.0.0.1:39001',
    config: { service_key: 'legacy-service-key' },
    metadata: { existing: true },
  });
  await db.insert(sandboxMembers).values({
    sandboxId: SANDBOX_ID,
    userId: MEMBER_ID,
    addedBy: ACCOUNT_ID,
  });
  await db.insert(sandboxInvites).values({
    sandboxId: SANDBOX_ID,
    accountId: ACCOUNT_ID,
    email: 'pending-migration@example.test',
    invitedBy: ACCOUNT_ID,
    initialRole: 'member',
  });
}

async function runMigrationCli(args: string[]) {
  if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required');

  const captureDir = mkdtempSync(join(tmpdir(), 'kortix-legacy-migration-cli-'));
  const stdoutFile = join(captureDir, 'stdout.log');
  const stderrFile = join(captureDir, 'stderr.log');

  let code = 1;
  let stdout = '';
  let stderr = '';

  try {
    const proc = Bun.spawnSync(
      [
        'bash',
        '-lc',
        'bun run src/scripts/migrate-legacy-sandboxes.ts "$@" >"$KORTIX_CLI_STDOUT" 2>"$KORTIX_CLI_STDERR"',
        'migrate-legacy-sandboxes',
        ...args,
      ],
      {
        cwd: API_PACKAGE_DIR,
        env: {
          ...process.env,
          DATABASE_URL: process.env.TEST_DATABASE_URL,
          INTERNAL_KORTIX_ENV: 'dev',
          KORTIX_CLI_STDOUT: stdoutFile,
          KORTIX_CLI_STDERR: stderrFile,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    code = proc.exitCode;
    stdout = readFileSync(stdoutFile, 'utf8');
    stderr = readFileSync(stderrFile, 'utf8');
  } finally {
    rmSync(captureDir, { recursive: true, force: true });
  }

  if (code !== 0) {
    throw new Error(`migration CLI failed with exit ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }

  const jsonStart = stdout.indexOf('{');
  const jsonEnd = stdout.lastIndexOf('}');
  if (jsonStart < 0 || jsonEnd < jsonStart) {
    throw new Error(`migration CLI did not print JSON\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }

  return JSON.parse(stdout.slice(jsonStart, jsonEnd + 1));
}

describeWithDb('legacy sandbox migration tooling', () => {
  beforeEach(async () => {
    await cleanup();
    await seedLegacySandbox();
  });

  afterEach(async () => {
    await cleanup();
  });

  test('renders repo URL templates with stable product identifiers', () => {
    const repoUrl = renderLegacyRepoUrl('https://github.com/org/{slug}-{sandbox_id}-{session_id}.git', {
      source_sandbox_id: SANDBOX_ID,
      account_id: ACCOUNT_ID,
      project_id: '00000000-0000-4000-a000-000000009301',
      session_id: SANDBOX_ID,
      project_name: 'Legacy Workspace',
      branch_name: SANDBOX_ID,
      provider: 'local_docker',
      external_id: 'legacy-container-1',
      base_url: 'http://127.0.0.1:39001',
      source_status: 'active',
      target_session_status: 'running',
      target_sandbox_status: 'active',
      member_user_ids: [ACCOUNT_ID, MEMBER_ID],
      pending_invite_emails: [],
    });

    expect(repoUrl).toBe(`https://github.com/org/legacy-workspace-${SANDBOX_ID}-${SANDBOX_ID}.git`);
  });

  test('dry-runs, applies, verifies, and rolls back one legacy sandbox migration', async () => {
    const db = getTestDb();

    const dryRun = await runLegacySandboxMigration({
      database: db,
      mode: 'dry_run',
      runId: RUN_ID,
      sandboxId: SANDBOX_ID,
      repoUrlTemplate: REPO_TEMPLATE,
    });
    expect(dryRun).toMatchObject({ scanned: 1, planned: 1, failed: 0 });
    expect(dryRun.items[0]?.plan?.source_sandbox_id).toBe(SANDBOX_ID);
    expect(dryRun.items[0]?.plan?.member_user_ids.sort()).toEqual([ACCOUNT_ID, MEMBER_ID].sort());

    const apply = await runLegacySandboxMigration({
      database: db,
      mode: 'apply',
      runId: RUN_ID,
      sandboxId: SANDBOX_ID,
      repoUrlTemplate: REPO_TEMPLATE,
      now: new Date('2026-05-15T00:00:00Z'),
    });
    expect(apply).toMatchObject({ scanned: 1, applied: 1, failed: 0 });
    const projectId = apply.items[0]!.plan!.project_id;

    const [project] = await db.select().from(projects).where(eq(projects.projectId, projectId)).limit(1);
    const [session] = await db.select().from(projectSessions).where(eq(projectSessions.sessionId, SANDBOX_ID)).limit(1);
    const [runtime] = await db.select().from(sessionSandboxes).where(eq(sessionSandboxes.sandboxId, SANDBOX_ID)).limit(1);
    const [legacy] = await db.select().from(sandboxes).where(eq(sandboxes.sandboxId, SANDBOX_ID)).limit(1);
    const migratedMembers = await db.select().from(accountMembers).where(eq(accountMembers.accountId, ACCOUNT_ID));
    const migratedInvites = await db.select().from(accountInvitations).where(eq(accountInvitations.accountId, ACCOUNT_ID));

    expect(project?.repoUrl).toContain('https://github.com/kortix-migrations/legacy-workspace-');
    expect(session?.projectId).toBe(projectId);
    expect(runtime?.sessionId).toBe(SANDBOX_ID);
    expect(legacy?.status).toBe('archived');
    expect(migratedMembers.map((row) => row.userId).sort()).toEqual([ACCOUNT_ID, MEMBER_ID].sort());
    expect(migratedInvites[0]?.email).toBe('pending-migration@example.test');

    const verify = await runLegacySandboxMigration({
      database: db,
      mode: 'verify',
      runId: RUN_ID,
      sandboxId: SANDBOX_ID,
      now: new Date('2026-05-15T00:01:00Z'),
    });
    expect(verify).toMatchObject({ scanned: 1, verified: 1, failed: 0 });
    expect(verify.items[0]?.checks).toMatchObject({
      project_exists: true,
      session_exists: true,
      runtime_exists: true,
      legacy_archived: true,
      ids_match: true,
    });

    const rollback = await runLegacySandboxMigration({
      database: db,
      mode: 'rollback',
      runId: RUN_ID,
      sandboxId: SANDBOX_ID,
      now: new Date('2026-05-15T00:02:00Z'),
    });
    expect(rollback).toMatchObject({ scanned: 1, rolled_back: 1, failed: 0 });

    const [rolledBackProject] = await db.select().from(projects).where(eq(projects.projectId, projectId)).limit(1);
    const [rolledBackSession] = await db.select().from(projectSessions).where(eq(projectSessions.sessionId, SANDBOX_ID)).limit(1);
    const [rolledBackRuntime] = await db.select().from(sessionSandboxes).where(eq(sessionSandboxes.sandboxId, SANDBOX_ID)).limit(1);
    const [restoredLegacy] = await db.select().from(sandboxes).where(eq(sandboxes.sandboxId, SANDBOX_ID)).limit(1);

    expect(rolledBackProject).toBeUndefined();
    expect(rolledBackSession).toBeUndefined();
    expect(rolledBackRuntime).toBeUndefined();
    expect(restoredLegacy?.status).toBe('active');
    expect(restoredLegacy?.metadata).toEqual({ existing: true });
  });

  test('CLI dry-runs, applies, verifies, and rolls back one legacy sandbox migration', async () => {
    const db = getTestDb();

    const dryRun = await runMigrationCli([
      '--dry-run',
      '--run-id', CLI_RUN_ID,
      '--sandbox-id', SANDBOX_ID,
      '--repo-url-template', REPO_TEMPLATE,
    ]);
    expect(dryRun).toMatchObject({ mode: 'dry_run', run_id: CLI_RUN_ID, scanned: 1, planned: 1, failed: 0 });

    const apply = await runMigrationCli([
      '--apply',
      '--run-id', CLI_RUN_ID,
      '--sandbox-id', SANDBOX_ID,
      '--repo-url-template', REPO_TEMPLATE,
    ]);
    expect(apply).toMatchObject({ mode: 'apply', run_id: CLI_RUN_ID, scanned: 1, applied: 1, failed: 0 });
    const projectId = apply.items[0]!.plan!.project_id;

    const verify = await runMigrationCli([
      '--verify',
      '--run-id', CLI_RUN_ID,
      '--sandbox-id', SANDBOX_ID,
    ]);
    expect(verify).toMatchObject({ mode: 'verify', run_id: CLI_RUN_ID, scanned: 1, verified: 1, failed: 0 });
    expect(verify.items[0]?.checks).toMatchObject({
      project_exists: true,
      session_exists: true,
      runtime_exists: true,
      legacy_archived: true,
      ids_match: true,
    });

    const rollback = await runMigrationCli([
      '--rollback',
      '--run-id', CLI_RUN_ID,
      '--sandbox-id', SANDBOX_ID,
    ]);
    expect(rollback).toMatchObject({ mode: 'rollback', run_id: CLI_RUN_ID, scanned: 1, rolled_back: 1, failed: 0 });

    const [rolledBackProject] = await db.select().from(projects).where(eq(projects.projectId, projectId)).limit(1);
    const [rolledBackSession] = await db.select().from(projectSessions).where(eq(projectSessions.sessionId, SANDBOX_ID)).limit(1);
    const [rolledBackRuntime] = await db.select().from(sessionSandboxes).where(eq(sessionSandboxes.sandboxId, SANDBOX_ID)).limit(1);
    const [restoredLegacy] = await db.select().from(sandboxes).where(eq(sandboxes.sandboxId, SANDBOX_ID)).limit(1);

    expect(rolledBackProject).toBeUndefined();
    expect(rolledBackSession).toBeUndefined();
    expect(rolledBackRuntime).toBeUndefined();
    expect(restoredLegacy?.status).toBe('active');
    expect(restoredLegacy?.metadata).toEqual({ existing: true });
  });
});
