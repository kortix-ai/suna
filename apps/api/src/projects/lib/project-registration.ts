import { type accountGithubInstallations, projectGitConnections } from '@kortix/db';

import { invalidateIamCacheForUser } from '../../iam/cache-invalidation';
import { grantProjectRole } from './access';
import { db } from '../../shared/db';
import type { GitHubRepo } from '../github';
import {
  type ProjectGitWriteAuth,
  buildProjectGitConnectionValues,
  buildProjectGitMetadata,
  upsertProjectGitCredential,
} from './project-git-write';
import { type ProjectRow, clampProjectName, deriveProjectName } from './serializers';
import { captureProductEvent } from '../../shared/product-analytics';
import {
  isWorkspaceOnePerAccountConflict,
  workspaceHasProjectBody,
  workspaceHasProjectDenial,
  WorkspaceHasProjectError,
} from '../../workspaces/one-project';
import { insertProjectRow } from '../../workspaces/rows';

type GitHubInstallation = typeof accountGithubInstallations.$inferSelect;

type RegistrationAuth =
  | {
      kind: 'github_app';
      installation: GitHubInstallation;
      /**
       * The installation is linked to another account: the connection is a
       * repository grant for this one repository (`project_grant: true`), the
       * BYO new-workspace path (`../routes/byo-new-workspace.ts`).
       */
      projectGrant?: boolean;
    }
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
  const now = new Date();
  const githubApp = input.auth.kind === 'github_app' ? input.auth.installation : null;
  const auth: ProjectGitWriteAuth = githubApp
    ? {
        kind: 'github_app',
        installationId: githubApp.installationId,
        permissions: githubApp.permissions,
        ...(input.auth.kind === 'github_app' && input.auth.projectGrant ? { projectGrant: true } : {}),
      }
    : { kind: 'project_credential' };
  const metadata = buildProjectGitMetadata(input.repo, auth, input.projectMetadata, {
    defaultBranch: input.defaultBranch,
    managed: input.managed ?? false,
    githubInstallationId: true,
  });

  // The route ran `enforceProjectQuota` (409 `workspace_has_project`) first. A
  // concurrent create that won the race past it trips the 1:1 unique index
  // here; that answers the same typed 409 instead of a 500.
  const row = await db.transaction(async (tx) => {
    const project = await insertProjectRow({
      accountId: input.accountId,
      name: projectName,
      repoUrl: input.repo.clone_url,
      defaultBranch: input.defaultBranch,
      manifestPath: input.manifestPath,
      status: 'active',
      metadata,
      updatedAt: now,
    }, tx);

    let credentialRef: string | null = null;
    if (input.auth.kind === 'project_credential') {
      credentialRef = await upsertProjectGitCredential(tx, {
        accountId: input.accountId,
        projectId: project.projectId,
        token: input.auth.token,
        createdBy: input.userId,
        now,
      });
    }

    const connectionValues = buildProjectGitConnectionValues(input.repo, auth, {
      defaultBranch: input.defaultBranch,
      credentialRef,
      now,
      managed: input.managed ?? false,
    });
    await tx
      .insert(projectGitConnections)
      .values({
        accountId: input.accountId,
        projectId: project.projectId,
        ...connectionValues,
      })
      .onConflictDoUpdate({
        target: projectGitConnections.projectId,
        set: connectionValues,
      })
      .returning();

    return project;
  }).catch(async (error: unknown) => {
    if (!isWorkspaceOnePerAccountConflict(error)) throw error;
    const occupied = await workspaceHasProjectDenial(input.accountId);
    throw new WorkspaceHasProjectError(occupied ?? workspaceHasProjectBody(input.accountId, null));
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
  // Prepare the project snapshot archive (S3 config provider) for the
  // default-branch tip at creation/import, so the first session already finds
  // it. Fire-and-forget, idempotent per (project, sha), no-op when the bucket
  // is not configured. Dynamic import: this module sits in a widely-mocked
  // graph and must not grow a static edge into the Git proxy.
  void import('../../git-proxy/project-snapshot')
    .then(({ queueProjectSnapshotForRef }) =>
      queueProjectSnapshotForRef(
        {
          projectId: row.projectId,
          repoUrl: row.repoUrl,
          defaultBranch: row.defaultBranch,
          manifestPath: row.manifestPath,
          gitAuthToken: null,
        },
        row.defaultBranch,
      ),
    )
    .catch((err) => {
      console.warn('[project-snapshot] enqueue after registration failed', {
        projectId: row.projectId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  captureProductEvent({
    userId: input.userId,
    accountId: input.accountId,
    event: 'project_created',
    dedupeKey: row.projectId,
    properties: { project_id: row.projectId, origin: 'github_import', git_auth: input.auth.kind },
  });
  return row;
}

export function registerGitHubLinkedProject(
  input: Omit<RegistrationInput, 'auth'> & { installation: GitHubInstallation; projectGrant?: boolean },
): Promise<ProjectRow> {
  const { installation, projectGrant, ...project } = input;
  return registerLinkedProject({
    ...project,
    auth: { kind: 'github_app', installation, ...(projectGrant ? { projectGrant: true } : {}) },
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
