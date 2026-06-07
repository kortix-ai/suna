import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { firstExistingExplicitEnvFile, requireEnvValue } from './env';

function escapeSql(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "''");
}

interface SeedSelfHostedProjectOptions {
  accountId: string;
  userId: string;
  name: string;
  repoUrl?: string;
}

export function runSelfHostedSql(sql: string): boolean {
  const envFile = firstExistingExplicitEnvFile();
  if (!envFile) return false;

  const composeFile = join(dirname(envFile), 'docker-compose.yml');
  if (!existsSync(composeFile)) return false;

  execFileSync(
    'docker',
    [
      'compose',
      '--project-name',
      process.env.E2E_COMPOSE_PROJECT_NAME || 'kortix-default',
      '--env-file',
      envFile,
      '-f',
      composeFile,
      'exec',
      '-T',
      'supabase-db',
      'psql',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      'postgres',
      '-d',
      'postgres',
    ],
    { input: sql, encoding: 'utf8' },
  );

  return true;
}

export function runSqlWithSelfHostFallback(sql: string): void {
  if (runSelfHostedSql(sql)) return;

  const databaseUrl = requireEnvValue('DATABASE_URL', 'apps/api/.env');
  execFileSync('psql', [databaseUrl, '-v', 'ON_ERROR_STOP=1', '-c', sql]);
}

export function seedSelfHostedProject({
  accountId,
  userId,
  name,
  repoUrl,
}: SeedSelfHostedProjectOptions): string {
  const projectId = randomUUID();
  const projectRepoUrl = repoUrl ?? `https://github.com/kortix-ai/sandbox-template-${projectId}.git`;
  const sql = `
insert into kortix.projects (
  project_id,
  account_id,
  name,
  repo_url,
  default_branch,
  manifest_path,
  status,
  metadata
) values (
  '${projectId}'::uuid,
  '${escapeSql(accountId)}'::uuid,
  '${escapeSql(name)}',
  '${escapeSql(projectRepoUrl)}',
  'main',
  'kortix.toml',
  'active',
  '{"self_host_e2e":true}'::jsonb
);

insert into kortix.project_members (
  account_id,
  project_id,
  user_id,
  project_role,
  granted_by
) values (
  '${escapeSql(accountId)}'::uuid,
  '${projectId}'::uuid,
  '${escapeSql(userId)}'::uuid,
  'manager',
  '${escapeSql(userId)}'::uuid
);
`;

  const seeded = runSelfHostedSql(sql);
  if (!seeded) throw new Error('E2E_ENV_FILE with adjacent docker-compose.yml is required for self-host project seeding');

  return projectId;
}
