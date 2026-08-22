import {
  type accountGithubInstallations,
  projectGitConnections,
  projectGitCredentials,
  projects,
} from '@kortix/db';

import { invalidateIamCacheForUser } from '../../iam/cache-invalidation';
import { grantProjectRole } from './access';
import { db } from '../../shared/db';
import type { GitHubRepo } from '../github';
import { encryptProjectSecret } from '../secrets';
import { type ProjectRow, clampProjectName, deriveProjectName } from './serializers';

type GitHubInstallation = typeof accountGithubInstallations.$inferSelect;

type RegistrationAuth =
  | { kind: 'github_app'; installation: GitHubInstallation }
  | { kind: 'project_credential'; token: string };

type RegistrationInput = {
  accountId: string;
  userId: string;
  repo: GitHubRepo;
  name?: string | null;
  defaultBranch: string;
  manifestPath: string;
  /** True only when Kortix created the upstream repository for this project. */
  managed?: boolean;
  /** Trusted server-owned metadata added at project creation. */
  projectMetadata?: Record<string, unknown>;
  auth: RegistrationAuth;
};

async function registerLinkedProject(input: RegistrationInput): Promise<ProjectRow> {
  const projectName = clampProjectName(input.name ?? deriveProjectName(input.repo.full_name));
  const owner = input.repo.full_name.split('/')[0] ?? null;
  const now = new Date();
  const githubApp = input.auth.kind === 'github_app' ? input.auth.installation : null;
  const authMethod = githubApp ? 'github_app' : 'project_credential';
  const metadata = {
    ...input.projectMetadata,
    git: {
      url: input.repo.clone_url,
      default_branch: input.defaultBranch,
      provider: 'github',
      owner,
      name: input.repo.name,
      external_repo_id: String(input.repo.id),
      managed: input.managed ?? false,
      auth: githubApp
        ? { method: authMethod, installation_id: githubApp.installationId }
        : { method: authMethod },
    },
    github: {
      repo_id: String(input.repo.id),
      full_name: input.repo.full_name,
      html_url: input.repo.html_url,
      private: input.repo.private,
      auth_source: githubApp ? 'app_installation' : 'pat',
      ...(githubApp ? { installation_id: githubApp.installationId } : {}),
    },
  };

  const row = await db.transaction(async (tx) => {
    const [project] = await tx
      .insert(projects)
      .values({
        accountId: input.accountId,
        name: projectName,
        repoUrl: input.repo.clone_url,
        defaultBranch: input.defaultBranch,
        manifestPath: input.manifestPath,
        status: 'active',
        metadata,
        updatedAt: now,
      })
      .returning();
    if (!project) throw new Error('Project registration did not return the inserted project');

    let credentialRef: string | null = null;
    if (input.auth.kind === 'project_credential') {
      const valueEnc = encryptProjectSecret(project.projectId, input.auth.token);
      const [credential] = await tx
        .insert(projectGitCredentials)
        .values({
          accountId: input.accountId,
          projectId: project.projectId,
          provider: 'github',
          authMethod: 'token',
          valueEnc,
          createdBy: input.userId,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [projectGitCredentials.projectId, projectGitCredentials.provider],
          set: {
            valueEnc,
            createdBy: input.userId,
            updatedAt: now,
          },
        })
        .returning();
      if (!credential) throw new Error('Project Git credential was not persisted');
      credentialRef = credential.credentialId;
    }

    const connection = {
      provider: 'github',
      repoUrl: input.repo.clone_url,
      repoOwner: owner,
      repoName: input.repo.name,
      externalRepoId: String(input.repo.id),
      managed: input.managed ?? false,
      defaultBranch: input.defaultBranch,
      authMethod,
      installationId: githubApp?.installationId ?? null,
      credentialRef,
      permissions: githubApp?.permissions ?? {},
      visibility: input.repo.private ? 'private' : 'public',
      status: 'connected',
      lastValidatedAt: now,
      lastErrorCode: null,
      lastErrorMessage: null,
      metadata: {
        full_name: input.repo.full_name,
        html_url: input.repo.html_url,
        ssh_url: input.repo.ssh_url,
      },
      updatedAt: now,
    };
    await tx
      .insert(projectGitConnections)
      .values({
        accountId: input.accountId,
        projectId: project.projectId,
        ...connection,
      })
      .onConflictDoUpdate({
        target: projectGitConnections.projectId,
        set: connection,
      })
      .returning();

    return project;
  });

  // The creator's Manager role, through the ONE write path.
  //
  // OUTSIDE the transaction, deliberately. `assignRole` is bound to the pooled
  // `db` handle, not to `tx`, so it cannot join the transaction above; running
  // it inside would silently open a SECOND connection and deadlock against the
  // row this transaction still holds. The failure mode of doing it after is
  // benign and self-healing: the project exists with no explicit member row, and
  // the creator — who must already be an account owner/admin to have reached
  // this route — still holds implicit Manager on every project in the account.
  // A thrown error propagates to the caller either way.
  await grantProjectRole({
    accountId: input.accountId,
    projectId: row.projectId,
    userId: input.userId,
    role: 'manager',
    grantedBy: input.userId,
  });

  invalidateIamCacheForUser(input.userId);
  return row;
}

export function registerGitHubLinkedProject(
  input: Omit<RegistrationInput, 'auth'> & { installation: GitHubInstallation },
): Promise<ProjectRow> {
  const { installation, ...project } = input;
  return registerLinkedProject({
    ...project,
    auth: { kind: 'github_app', installation },
  });
}

export function registerPatLinkedProject(
  input: Omit<RegistrationInput, 'auth'> & { token: string },
): Promise<ProjectRow> {
  const { token, ...project } = input;
  return registerLinkedProject({
    ...project,
    auth: { kind: 'project_credential', token },
  });
}
