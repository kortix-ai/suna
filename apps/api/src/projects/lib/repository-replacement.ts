import { changeRequests, projectGitConnections, projectGitCredentials, projectSessions, projects } from '@kortix/db';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../../shared/db';
import { createInstallationToken, getFileSha, getGitHubAppInstallation, parseGitHubRepoUrl, verifyGitHubInstallationAdmin, type GitHubRepo } from '../github';
import { invalidateProjectMirror } from '../git';
import { encryptProjectSecret } from '../secrets';
import { copySharedSecretsIntoProject, type SharedSecretCopy } from './repository-secret-copy';
import {
  buildProjectGitConnectionValues,
  buildProjectGitMetadata,
  type ProjectGitWriteAuth,
} from './project-git-write';
import { resolveGitHubImportWithPat } from './git';

export class RepositoryChangedError extends Error {}
export class RepositoryManifestMissingError extends Error {}
export class RepositoryValidationError extends Error {}

/** Verify the new repository before replacing the project and credential together. */
export async function replaceProjectRepository(input: {
  projectId: string;
  accountId: string;
  actorId: string;
  expectedRepoUrl: string;
  repoUrl: string;
  token: string;
  installationId?: string;
  githubUserToken?: string;
  copySharedSecrets?: SharedSecretCopy;
}) {
  let token = input.token;
  if (input.installationId) {
    const parsed = parseGitHubRepoUrl(input.repoUrl);
    if (!parsed || !input.githubUserToken) throw new RepositoryValidationError('GitHub App grant requires a repository and user authorization');
    try {
      const installation = await getGitHubAppInstallation(input.installationId);
      await verifyGitHubInstallationAdmin(input.githubUserToken, installation);
      if (installation.account?.login?.toLowerCase() !== parsed.owner.toLowerCase()) {
        throw new Error('GitHub installation does not own this repository');
      }
      token = (await createInstallationToken(input.installationId, [parsed.repo])).token;
    } catch (error) {
      throw new RepositoryValidationError(error instanceof Error ? error.message : 'Could not authorize GitHub App grant');
    }
  }
  let imported: Awaited<ReturnType<typeof resolveGitHubImportWithPat>>;
  try {
    imported = await resolveGitHubImportWithPat({ repoUrl: input.repoUrl, token });
  } catch (error) {
    throw new RepositoryValidationError(error instanceof Error ? error.message : 'Could not validate GitHub repository');
  }
  const owner = imported.repo.full_name.split('/')[0]!;
  const manifestPath = await db.select({ manifestPath: projects.manifestPath })
    .from(projects).where(eq(projects.projectId, input.projectId)).limit(1);
  if (!manifestPath[0]) throw new RepositoryChangedError('Project is no longer available');
  let manifestSha: string | null;
  try {
    manifestSha = await getFileSha({
      owner,
      repo: imported.repo.name,
      path: manifestPath[0].manifestPath,
      branch: imported.defaultBranch,
      auth: { token, source: input.installationId ? 'app_installation' : 'project_credential' },
    });
  } catch (error) {
    throw new RepositoryValidationError(error instanceof Error ? error.message : 'Could not read repository manifest');
  }
  if (!manifestSha) throw new RepositoryManifestMissingError(`Repository has no ${manifestPath[0].manifestPath} on ${imported.defaultBranch}`);

  const result = await persistProjectRepositoryReplacement({
    ...input,
    token,
    repo: imported.repo,
    defaultBranch: imported.defaultBranch,
    expectedManifestPath: manifestPath[0].manifestPath,
  });
  return { ...result, gitAuthToken: token };
}

/** The write half accepts only a repository verified by the caller. */
export async function persistProjectRepositoryReplacement(input: {
  projectId: string;
  accountId: string;
  actorId: string;
  expectedRepoUrl: string;
  expectedManifestPath: string;
  token: string;
  installationId?: string;
  repo: GitHubRepo;
  defaultBranch: string;
  copySharedSecrets?: SharedSecretCopy;
}) {
  const now = new Date();
  const auth: ProjectGitWriteAuth = input.installationId
    ? { kind: 'github_app', installationId: input.installationId, projectGrant: true }
    : { kind: 'project_credential' };
  const result = await db.transaction(async (tx) => {
    const [oldProject] = await tx.select().from(projects)
      .where(eq(projects.projectId, input.projectId)).for('update');
    if (!oldProject || oldProject.accountId !== input.accountId || oldProject.status !== 'active') {
      throw new RepositoryChangedError('Project is no longer available');
    }
    if (oldProject.repoUrl !== input.expectedRepoUrl || oldProject.manifestPath !== input.expectedManifestPath) {
      throw new RepositoryChangedError('Project repository or manifest changed; reload and retry');
    }
    if (oldProject.repoUrl === input.repo.clone_url) {
      throw new RepositoryChangedError('Project already uses this repository');
    }
    const [activeSession] = await tx.select({ sessionId: projectSessions.sessionId })
      .from(projectSessions).where(and(
        eq(projectSessions.projectId, input.projectId),
        inArray(projectSessions.status, ['queued', 'branching', 'provisioning', 'running']),
      )).limit(1);
    if (activeSession) throw new RepositoryChangedError('Stop active sessions before changing the repository');
    const [openChangeRequest] = await tx.select({ crId: changeRequests.crId })
      .from(changeRequests).where(and(
        eq(changeRequests.projectId, input.projectId),
        eq(changeRequests.status, 'open'),
      )).limit(1);
    if (openChangeRequest) throw new RepositoryChangedError('Close or merge open change requests before changing the repository');

    // The optional secret-copy sub-job runs inside this same transaction: a
    // refusal throws and aborts the whole swap (repository-secret-copy.ts).
    if (input.copySharedSecrets) {
      await copySharedSecretsIntoProject(tx, {
        ...input.copySharedSecrets,
        targetProjectId: input.projectId,
        accountId: input.accountId,
        actorId: input.actorId,
        now,
      });
    }

    let credentialId: string | null = null;
    if (input.installationId) {
      await tx.delete(projectGitCredentials).where(and(
        eq(projectGitCredentials.projectId, input.projectId),
        eq(projectGitCredentials.provider, 'github'),
      ));
    } else {
      const valueEnc = encryptProjectSecret(input.projectId, input.token);
      const [credential] = await tx.insert(projectGitCredentials).values({
        accountId: input.accountId, projectId: input.projectId, provider: 'github',
        authMethod: 'token', valueEnc, createdBy: input.actorId, updatedAt: now,
      }).onConflictDoUpdate({
        target: [projectGitCredentials.projectId, projectGitCredentials.provider],
        set: { valueEnc, createdBy: input.actorId, updatedAt: now },
      }).returning();
      if (!credential) throw new Error('Project Git credential was not persisted');
      credentialId = credential.credentialId;
    }

    const connectionValues = buildProjectGitConnectionValues(input.repo, auth, {
      defaultBranch: input.defaultBranch,
      credentialRef: credentialId,
      now,
      upstreamUrl: input.repo.clone_url,
    });
    const [connection] = await tx.insert(projectGitConnections).values({
      accountId: input.accountId, projectId: input.projectId, ...connectionValues,
    }).onConflictDoUpdate({
      target: projectGitConnections.projectId,
      set: connectionValues,
    }).returning();
    if (!connection) throw new Error('Project Git connection was not persisted');

    const existingMetadata = oldProject.metadata && typeof oldProject.metadata === 'object'
      ? oldProject.metadata as Record<string, unknown> : {};
    const metadata = {
      ...buildProjectGitMetadata(input.repo, auth, existingMetadata, {
        defaultBranch: input.defaultBranch,
      }),
      // What this generation still decides, and all it decides: the git-proxy
      // authorization memo and the upstream memo are keyed by it, so a
      // replacement busts both instead of serving the old upstream for another
      // 30 s (`sameRepository` in projects/lib/git.ts, `resolveProjectUpstreamMemo`
      // in git-proxy/index.ts); `/start` reports it as telemetry; and the web
      // shows an older session a notice about its own clone. It does NOT
      // freeze the session: every session of this project receives the
      // project's current config release and converges normally. What is
      // left is physical — that clone and the new origin hold unrelated
      // histories, so Git itself refuses a push without a rebase.
      repository_generation: randomUUID(),
    };
    const [project] = await tx.update(projects).set({
      repoUrl: input.repo.clone_url,
      defaultBranch: input.defaultBranch,
      metadata,
      updatedAt: now,
    }).where(eq(projects.projectId, input.projectId)).returning();
    if (!project) throw new Error('Project repository was not persisted');
    return { project, connection };
  });

  invalidateProjectMirror(input.projectId);
  // The base branch now points into another repository: new config.
  void import('./config-convergence-triggers')
    .then((triggers) => triggers.notifyBaseBranchMoved(input.projectId, input.defaultBranch, 'repository-replacement'))
    .catch(() => {});
  return result;
}
