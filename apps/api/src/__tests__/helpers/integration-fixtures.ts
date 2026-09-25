// Synthetic account, project, and session rows for real-PostgreSQL integration
// suites.
//
// The db-suites lane gives every file a fresh database cloned from the migrated
// template: it holds no account and no project. A suite seeds the rows it needs
// here instead of borrowing a row some other writer created.
import { accounts, projectSessions, projects } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { db } from '../../shared/db';

const TEST_DB_CONFIRMATION = 'I_UNDERSTAND_THIS_DELETES_TEST_DATA';
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * The confirmed local test database, or a throw. A suite that opens its own
 * `pg` client uses this URL; the product code under test writes through
 * `DATABASE_URL`, so both must name the same loopback database.
 */
export function localTestDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url || process.env.KORTIX_TEST_DB_CONFIRM !== TEST_DB_CONFIRMATION) {
    throw new Error(
      `Run against the local test database: set TEST_DATABASE_URL and KORTIX_TEST_DB_CONFIRM=${TEST_DB_CONFIRMATION}`,
    );
  }
  if (!LOOPBACK_HOSTS.has(new URL(url).hostname)) {
    throw new Error('TEST_DATABASE_URL must point at a loopback host');
  }
  if (process.env.DATABASE_URL !== url) {
    throw new Error('DATABASE_URL must equal TEST_DATABASE_URL');
  }
  return url;
}

/** Snake case, to match the raw `kortix.projects` rows the suites read. */
export interface SeededProject {
  account_id: string;
  project_id: string;
}

export async function seedAccount(label: string): Promise<string> {
  const accountId = crypto.randomUUID();
  await db.insert(accounts).values({ accountId, name: `${label}-account` });
  return accountId;
}

/** One project, in `accountId` or in a new synthetic account. */
export async function seedProject(
  label: string,
  options: { accountId?: string; metadata?: Record<string, unknown> } = {},
): Promise<SeededProject> {
  const account_id = options.accountId ?? (await seedAccount(label));
  const project_id = crypto.randomUUID();
  await db.insert(projects).values({
    projectId: project_id,
    accountId: account_id,
    name: label,
    repoUrl: `https://example.test/${label}.git`,
    ...(options.metadata ? { metadata: options.metadata } : {}),
  });
  return { account_id, project_id };
}

/** One private session in `project`, owned by `createdBy`. */
export async function seedSession(project: SeededProject, createdBy: string): Promise<string> {
  const sessionId = crypto.randomUUID();
  await db.insert(projectSessions).values({
    sessionId,
    accountId: project.account_id,
    projectId: project.project_id,
    branchName: `session/${sessionId}`,
    createdBy,
  });
  return sessionId;
}

/** Deletes the seeded projects, then their accounts. Delete child rows first. */
export async function removeSeeded(seeded: SeededProject[]): Promise<void> {
  for (const { project_id } of seeded) {
    await db.delete(projects).where(eq(projects.projectId, project_id));
  }
  for (const accountId of new Set(seeded.map((row) => row.account_id))) {
    await db.delete(accounts).where(eq(accounts.accountId, accountId));
  }
}
