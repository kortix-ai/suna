import {
  accountGithubInstallations,
  projectGitConnections,
  projectGitCredentials,
  projectMembers,
  projects,
} from '@kortix/db';

import { invalidateIamCacheForUser } from '../../iam/cache-invalidation';
import { db } from '../../shared/db';
import type { GitHubRepo } from '../github';
import { encryptProjectSecret } from '../secrets';
import { clampProjectName, deriveProjectName, type ProjectRow } from './serializers';
import { and, eq } from 'drizzle-orm';

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
  auth: RegistrationAuth;
};

async function registerLinkedProject(input: RegistrationInput): Promise<ProjectRow> {
  const projectName = clampProjectName(input.name ?? deriveProjectName(input.repo.full_name));
  const owner = input.repo.full_name.split('/')[0] ?? null;
  const now = new Date();
  const githubApp = input.auth.kind === 'github_app' ? input.auth.installation : null;
  const authMethod = githubApp ? 'github_app' : 'project_credential';
  const metadata = {
    git: {
      url: input.repo.clone_url,
      default_branch: input.defaultBranch,
      provider: 'github',
      owner,
      name: input.repo.name,
      external_repo_id: String(input.repo.id),
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
    const [inserted] = await tx
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
      // Phase-one compatibility: production still has the historical unique
      // (account_id, repo_url) index. Once phase two makes that index
      // non-unique, this insert naturally creates an independent project.
      .onConflictDoNothing()
      .returning();

    let project = inserted;
    if (!inserted) {
      const [existing] = await tx
        .select()
        .from(projects)
        .where(
          and(
            eq(projects.accountId, input.accountId),
            eq(projects.repoUrl, input.repo.clone_url),
          ),
        )
        .limit(1);
      if (!existing) {
        throw new Error('Project registration conflicted without an existing repository project');
      }
      const [updated] = await tx
        .update(projects)
        .set({
          name: projectName,
          defaultBranch: input.defaultBranch,
          manifestPath: input.manifestPath,
          status: 'active',
          metadata,
          updatedAt: now,
        })
        .where(eq(projects.projectId, existing.projectId))
        .returning();
      if (!updated) throw new Error('Existing repository project disappeared during registration');
      project = updated;
    }

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

    await tx
      .insert(projectMembers)
      .values({
        accountId: input.accountId,
        projectId: project.projectId,
        userId: input.userId,
        projectRole: 'manager',
        grantedBy: input.userId,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [projectMembers.projectId, projectMembers.userId],
        set: {
          projectRole: 'manager',
          grantedBy: input.userId,
          updatedAt: now,
        },
      })
      .returning();

    return project;
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
