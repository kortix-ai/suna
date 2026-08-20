/**
 * A project whose `kortix.yaml` the API can actually read and write.
 *
 * Some browser journeys need real manifest content, not just a project row:
 *
 *  - 21-trigger-session-access `POST /projects/:id/triggers`, which commits the
 *    trigger into `kortix.yaml` and pushes it.
 *  - 22-resource-grant-multiselect `GET /projects/:id/resource-grants`, whose
 *    agent list is `config.agents` read out of the same manifest.
 *
 * Both used to build the project with `createDatabaseProject` pointed at
 * `createLocalGitRepository`, a bare repo under the RUNNER's `/tmp`. That works
 * locally, where the API is the same machine. Against a deployed target the API
 * runs in ECS and cannot see that path, so:
 *
 *  - the trigger POST answered `502 "No git credentials available to write to
 *    the project repo"` — the Cloudflare edge launders origin 5xx into
 *    `503 MAINTENANCE_MODE`, which is exactly what spec 21 reported on every
 *    release run, and `helpers/http.ts` retried for its full 60s budget because
 *    the failure is deterministic, not transient;
 *  - the resource-grants read swallowed the repo error and returned an EMPTY
 *    agent list, so spec 22's "kortix" checkbox could never appear.
 *
 * A staging row left over from a release run still carries
 * `repo_url = /tmp/ke2e-git-0c24dr/remote.git`, which is the defect in one line.
 *
 * `src/fixtures/world.ts` already draws this distinction for the REST lane:
 * database projects with a local git remote on `local`, provisioned managed-git
 * projects everywhere else. This is the same rule for the browser lane.
 */
import { execFileSync } from 'node:child_process';

import type { LocalGitRepository } from '../../src/fixtures/local-git';
import { createLocalGitRepository } from '../../src/fixtures/local-git';
import { loadEnv } from '../../src/core/env';
import { createDatabaseProject, deleteDatabaseProject } from '../../src/fixtures/database-project';

/**
 * True when the suite runs against a deployed origin (staging, preview) rather
 * than the local stack. `local-runner.ts` sets KE2E_TARGET only for those lanes.
 */
export function isDeployedTarget(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.KE2E_TARGET);
}

export interface ManifestProject {
  id: string;
  dispose: () => Promise<void>;
}

/**
 * Provisioning goes through billing, and a free account may hold ONE project:
 * `POST /projects/provision` answers
 * `409 {"code":"project_limit_reached"}` otherwise. 13-sdk-only already funds
 * its account by SQL for the same reason; this is that statement, shared.
 */
export function fundAccount(databaseUrl: string, accountId: string): void {
  execFileSync(
    'psql',
    [
      databaseUrl,
      '-v',
      'ON_ERROR_STOP=1',
      '-At',
      '-c',
      `INSERT INTO kortix.credit_accounts (
         account_id, balance, balance_precise,
         non_expiring_credits, non_expiring_credits_precise, tier
       )
       VALUES ('${accountId}', 1000, 1000, 1000, 1000, 'tier_2_20')
       ON CONFLICT (account_id) DO UPDATE SET
         balance = 1000, balance_precise = 1000,
         non_expiring_credits = 1000, non_expiring_credits_precise = 1000,
         tier = 'tier_2_20'`,
    ],
    { encoding: 'utf8' },
  );
}

interface ProvisionResponse {
  project_id: string;
}

type ApiClient = <T>(
  token: string,
  method: string,
  path: string,
  body?: Record<string, unknown>,
  expectedStatus?: number | number[],
) => Promise<T>;

export interface ManifestProjectOptions {
  api: ApiClient;
  accessToken: string;
  accountId: string;
  userId: string;
  name: string;
  databaseUrl: string;
}

/**
 * On a deployed target: fund the account, then provision a real managed-git
 * project seeded from the starter, so `kortix.yaml` exists and is reachable.
 * On local: the existing database project on a local bare repo, unchanged.
 */
export async function createManifestProject(
  options: ManifestProjectOptions,
): Promise<ManifestProject> {
  const { api, accessToken, accountId, userId, name, databaseUrl } = options;
  if (isDeployedTarget()) {
    fundAccount(databaseUrl, accountId);
    const project = await api<ProvisionResponse>(
      accessToken,
      'POST',
      '/projects/provision',
      { account_id: accountId, name, seed_starter: true },
      201,
    );
    // A provisioned project starts with the onboarding survey pending, while a
    // database project never had it. Left pending, the "Tell us about your
    // company" modal remounts on each navigation, covers the page, and — worse
    // than hiding a control — answers `page.getByRole('dialog')` itself, so an
    // assertion about the command palette silently reads the survey. 13-sdk-only
    // completes it for the same reason.
    await api(
      accessToken,
      'PATCH',
      `/projects/${project.project_id}/onboarding`,
      { completed: true },
    );
    return {
      id: project.project_id,
      dispose: async () => {
        await api(accessToken, 'DELETE', `/projects/${project.project_id}`, undefined, [
          200, 204, 404,
        ]).catch(() => undefined);
      },
    };
  }

  const env = loadEnv();
  const repository: LocalGitRepository = await createLocalGitRepository(name);
  const project = await createDatabaseProject(env, {
    accountId,
    userId,
    name,
    repoUrl: repository.repoUrl,
  });
  return {
    id: project.id,
    dispose: async () => {
      await deleteDatabaseProject(env, project.id).catch(() => undefined);
      await repository.dispose();
    },
  };
}
