import { changeRequests, projectGitConnections, projectGitCredentials, projectSecrets, projectSessions, projects } from '@kortix/db';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { db } from '../../shared/db';
import { createInstallationToken, getFileSha, getGitHubAppInstallation, parseGitHubRepoUrl, verifyGitHubInstallationAdmin, type GitHubRepo } from '../github';
import { invalidateProjectMirror } from '../git';
import { decryptProjectSecret, encryptProjectSecret } from '../secrets';
import { resolveGitHubImportWithPat } from './git';

export class RepositoryChangedError extends Error {}
export class RepositoryManifestMissingError extends Error {}
export class RepositoryValidationError extends Error {}
export class RepositorySecretCopyError extends Error {}

type SharedSecretCopy = { sourceProjectId: string; identifiers: string[] };

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
  const owner = input.repo.full_name.split('/')[0]!;
  const now = new Date();
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

    if (input.copySharedSecrets) {
      const { sourceProjectId, identifiers } = input.copySharedSecrets;
      const unique = [...new Set(identifiers)];
      if (sourceProjectId === input.projectId || unique.length !== identifiers.length || unique.length === 0) {
        throw new RepositorySecretCopyError('Select distinct shared secret identifiers from another project');
      }
      const [source] = await tx.select({ accountId: projects.accountId, status: projects.status })
        .from(projects).where(eq(projects.projectId, sourceProjectId)).limit(1);
      if (!source || source.accountId !== input.accountId || source.status !== 'active') {
        throw new RepositorySecretCopyError('Secret source project is not available in this account');
      }
      const sourceRows = await tx.select().from(projectSecrets).where(and(
        eq(projectSecrets.projectId, sourceProjectId),
        inArray(projectSecrets.identifier, unique),
        isNull(projectSecrets.ownerUserId),
      ));
      const sourceByIdentifier = new Map(sourceRows.map((row) => [row.identifier, row]));
      const existing = await tx.select({ identifier: projectSecrets.identifier }).from(projectSecrets).where(and(
        eq(projectSecrets.projectId, input.projectId),
        inArray(projectSecrets.identifier, unique),
        isNull(projectSecrets.ownerUserId),
      ));
      if (existing.length) throw new RepositorySecretCopyError(`Target already has ${existing[0]!.identifier}`);
      for (const identifier of unique) {
        const row = sourceByIdentifier.get(identifier);
        if (!row || !row.active) throw new RepositorySecretCopyError(`Source has no active shared ${identifier}`);
        if (row.scope !== 'runtime' || row.strategy !== 'runtime' || identifier.toUpperCase().startsWith('KORTIX_') || identifier.toUpperCase() === 'CODEX_AUTH_JSON') {
          throw new RepositorySecretCopyError(`${identifier} cannot be copied with a repository replacement`);
        }
      }
      await tx.insert(projectSecrets).values(unique.map((identifier) => {
        const row = sourceByIdentifier.get(identifier)!;
        return {
          projectId: input.projectId, identifier, name: row.name,
          valueEnc: encryptProjectSecret(input.projectId, decryptProjectSecret(sourceProjectId, row.valueEnc)),
          scope: row.scope, strategy: row.strategy, consumer: row.consumer,
          description: row.description, createdBy: input.actorId, updatedAt: now,
        };
      }));
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

    const connectionValues = {
      provider: 'github', repoUrl: input.repo.clone_url,
      upstreamUrl: input.repo.clone_url, managed: false,
      repoOwner: owner, repoName: input.repo.name,
      externalRepoId: String(input.repo.id), defaultBranch: input.defaultBranch,
      authMethod: input.installationId ? 'github_app' : 'project_credential', installationId: input.installationId ?? null,
      credentialRef: credentialId, permissions: {},
      visibility: input.repo.private ? 'private' : 'public',
      webhookId: null, status: 'connected', lastValidatedAt: now,
      lastErrorCode: null, lastErrorMessage: null,
      metadata: { full_name: input.repo.full_name, html_url: input.repo.html_url, ssh_url: input.repo.ssh_url,
        ...(input.installationId ? { project_grant: true } : {}) },
      updatedAt: now,
    };
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
      ...existingMetadata,
      // Old sessions have no matching generation and cannot resume or use the
      // project-scoped Git proxy against this new upstream.
      repository_generation: randomUUID(),
      git: {
        url: input.repo.clone_url, default_branch: input.defaultBranch,
        provider: 'github', owner, name: input.repo.name,
        external_repo_id: String(input.repo.id), managed: false,
        auth: input.installationId
          ? { method: 'github_app', installation_id: input.installationId, project_grant: true }
          : { method: 'project_credential' },
      },
      github: {
        repo_id: String(input.repo.id), full_name: input.repo.full_name,
        html_url: input.repo.html_url, private: input.repo.private,
        auth_source: input.installationId ? 'app_installation' : 'pat',
      },
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
  return result;
}
