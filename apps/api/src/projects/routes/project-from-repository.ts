/** Create a project from a repository: link an existing GitHub repo, or create a new one. */
import { ACCOUNT_ACTIONS, assertAuthorized } from '../../iam';
import { actorOf } from '../../iam/actor';
import { auth, errors, json } from '../../openapi';
import { kickProjectTemplatePrebuilds } from '../../snapshots/builder';
import { isSelfHostOperator } from '../../shared/platform-roles';
import { managedGithubToken } from '../git-backends';
import { commitFile, createRepo, getFileSha } from '../github';
import { buildProjectSeedFilesFromItem } from '../seed-files';
import { buildStarterFiles, normalizeStarterTemplateId } from '../starter';
import { createRoute, z } from '@hono/zod-openapi';
import { enforceProjectQuota, resolveProjectAccount } from '../lib/access';
import { AnyObject, projectsApp } from '../lib/app';
import {
  GitHubInstallationAmbiguousError,
  GitHubInstallationRequiredError,
  createGitHubInstallationInstallUrl,
  getProjectGitConnection,
  resolveGitHubImport,
  resolveGitHubImportWithPat,
  resolveGitHubRepoAuth,
} from '../lib/git';
import {
  githubInstallationUnreachableBody,
  isGitHubInstallationUnreachable,
} from '../lib/github-installation-errors';
import { normalizeProjectIcon } from '../lib/project-icon';
import { normalizeProjectGlyph } from '../lib/project-glyph';
import { registerGitHubLinkedProject, registerPatLinkedProject } from '../lib/project-registration';
import {
  deriveProjectName,
  isRepoNameTakenError,
  normalizeString,
  readBody,
  serializeProject,
  serializeProjectGitConnection,
} from '../lib/serializers';
import { getCatalogItemDetail } from '../../marketplace/catalog';

// POST /v1/projects/link-repository
// Import an existing GitHub repo through the account GitHub App installation.
// This validates repo access up front and stores a typed project_git_connection.

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/link-repository',
    tags: ['github'],
    summary: 'POST /link-repository',
    ...auth,
      request: {
        body: { content: { 'application/json': { schema: AnyObject } } },
      },
    responses: {
        201: json(z.any(), 'OK'),
        ...errors(400, 403, 409),
    },
  }),
  async (c: any) => {
  const body = await readBody(c);
  const scope = await resolveProjectAccount(c, body);
  await assertAuthorized(await actorOf(c, scope.accountId), ACCOUNT_ACTIONS.PROJECT_CREATE);

  const repoFullName = normalizeString(body.repo_full_name ?? body.repoFullName);
  const repoUrlInput = normalizeString(body.repo_url ?? body.repoUrl);
  const repoUrl = repoFullName
    ? `https://github.com/${repoFullName.replace(/\.git$/i, '')}.git`
    : repoUrlInput;
  if (!repoUrl) return c.json({ error: 'repo_url or repo_full_name is required' }, 400);

  const installationIdInput = normalizeString(body.installation_id ?? body.installationId);
  // `source: 'managed'` imports through the INSTANCE git backend instead of an
  // account connection. It is the one place the instance backend meets an
  // account flow, and it is self-host-operator gated: the backend owner on
  // cloud is the shared `managed-kortix` org, and `isPlatformAdmin` admits
  // staff, so that gate once let one customer import another's repository.
  const managedImport = normalizeString(body.source) === 'managed';
  if (managedImport && installationIdInput) {
    return c.json({ error: 'source: managed and installation_id are mutually exclusive' }, 400);
  }
  if (managedImport && !(await isSelfHostOperator(scope.userId))) {
    return c.json(
      { error: 'Managed GitHub repository import is only available to a self-host operator' },
      403,
    );
  }

  const quota = await enforceProjectQuota(c, scope.accountId);
  if (quota) return quota;

  const manifestPath = normalizeString(body.manifest_path ?? body.manifestPath) ?? 'kortix.yaml';

  // Token path: link an existing repo with a token, no GitHub App install
  // needed — either a caller-supplied token (the seamless `kortix ship` flow
  // for a repo you already own, and the App-free fallback in environments
  // where the App can't be installed), or the INSTANCE git backend's own token
  // when the caller selects it with `source: 'managed'` (operator-gated
  // above). Everything downstream (`resolveProjectGitAuth` →
  // `project_credential`) consumes the stored token either way.
  const githubToken = normalizeString(body.github_token ?? body.githubToken);
  const managedPatToken = !githubToken && managedImport ? managedGithubToken() : null;
  if (!githubToken && managedImport && !managedPatToken) {
    return c.json(
      { error: 'This server has no token-backed instance git backend configured' },
      409,
    );
  }
  const patToken = githubToken ?? managedPatToken;
  if (patToken) {
    let patImport: Awaited<ReturnType<typeof resolveGitHubImportWithPat>>;
    try {
      patImport = await resolveGitHubImportWithPat({
        repoUrl,
        token: patToken,
        defaultBranch: normalizeString(body.default_branch ?? body.defaultBranch),
      });
    } catch (error) {
      return c.json({ error: (error as Error).message || 'Failed to validate GitHub repository' }, 400);
    }
    // Same "degrade, never fail the create" rationale as projects.ts's provision
    // handler — see the comment there.
    const icon = normalizeProjectIcon(body.icon);
    const iconGlyph = normalizeProjectGlyph(body.icon_glyph);
    const row = await registerPatLinkedProject({
      accountId: scope.accountId,
      userId: scope.userId,
      repo: patImport.repo,
      token: patToken,
      name: normalizeString(body.name),
      defaultBranch: patImport.defaultBranch,
      manifestPath,
      ...(iconGlyph
        ? { projectMetadata: { icon_glyph: iconGlyph } }
        : icon
          ? { projectMetadata: { icon } }
          : {}),
    });
    kickProjectTemplatePrebuilds(
      { projectId: row.projectId, repoUrl: row.repoUrl, defaultBranch: row.defaultBranch, manifestPath: row.manifestPath, gitAuthToken: patToken },
      { accountId: scope.accountId, source: 'project-create' },
    );
    return c.json({
      project: serializeProject(row, { projectRole: 'manager', effectiveRole: 'manager' }),
      git_connection: serializeProjectGitConnection(await getProjectGitConnection(row.projectId)),
    }, 201);
  }

  let imported: Awaited<ReturnType<typeof resolveGitHubImport>>;
  try {
    imported = await resolveGitHubImport({
      accountId: scope.accountId,
      repoUrl,
      installationId: installationIdInput,
      defaultBranch: normalizeString(body.default_branch ?? body.defaultBranch),
    });
  } catch (error) {
    if (error instanceof GitHubInstallationRequiredError) {
      return c.json({
        error: error.message,
        install_url: await createGitHubInstallationInstallUrl(error.accountId, scope.userId),
      }, 409);
    }
    // A dead connection is a reconnect prompt, never a raw GitHub string.
    if (isGitHubInstallationUnreachable(error)) {
      return c.json(
        githubInstallationUnreachableBody(
          installationIdInput ?? '',
          await createGitHubInstallationInstallUrl(scope.accountId, scope.userId),
        ),
        409,
      );
    }
    return c.json({ error: (error as Error).message || 'Failed to validate GitHub repository' }, 400);
  }

  const icon = normalizeProjectIcon(body.icon);
  const iconGlyph = normalizeProjectGlyph(body.icon_glyph);
  const row = await registerGitHubLinkedProject({
    accountId: scope.accountId,
    userId: scope.userId,
    repo: imported.repo,
    installation: imported.installation,
    name: normalizeString(body.name),
    defaultBranch: imported.defaultBranch,
    manifestPath,
    ...(iconGlyph
      ? { projectMetadata: { icon_glyph: iconGlyph } }
      : icon
        ? { projectMetadata: { icon } }
        : {}),
  });

  kickProjectTemplatePrebuilds(
    {
      projectId: row.projectId,
      repoUrl: row.repoUrl,
      defaultBranch: row.defaultBranch,
      manifestPath: row.manifestPath,
      gitAuthToken: imported.auth.token,
    },
    { accountId: scope.accountId, source: 'project-create' },
  );

  return c.json({
    project: serializeProject(row, { projectRole: 'manager', effectiveRole: 'manager' }),
    git_connection: serializeProjectGitConnection(await getProjectGitConnection(row.projectId)),
  }, 201);
},
);

// POST /v1/projects/create-repo
// Creates a new GitHub repository using the account's GitHub App installation,
// then registers it as a Kortix project.

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/create-repo',
    tags: ['github'],
    summary: 'POST /create-repo',
    ...auth,
      request: {
        body: { content: { 'application/json': { schema: AnyObject } } },
      },
    responses: {
        201: json(z.any(), 'OK'),
        ...errors(400, 409, 502, 503),
    },
  }),
  async (c: any) => {
  const body = await readBody(c);
  const scope = await resolveProjectAccount(c, body);
  await assertAuthorized(await actorOf(c, scope.accountId), ACCOUNT_ACTIONS.PROJECT_CREATE);

  const name = normalizeString(body.name);
  if (!name) return c.json({ error: 'name is required' }, 400);
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
    return c.json({ error: 'name must contain only letters, numbers, hyphens, underscores or dots' }, 400);
  }

  // Resolve through the public marketplace detail gate before creating
  // anything upstream. Hidden/support items remain internal even when a caller
  // knows their catalog id.
  const sourceItemId = normalizeString(body.source_item_id ?? body.sourceItemId);
  if (sourceItemId) {
    const sourceItem = await getCatalogItemDetail(sourceItemId);
    if (!sourceItem || sourceItem.type !== 'registry:project') {
      return c.json({ error: `Unknown or non-cloneable project item "${sourceItemId}"` }, 400);
    }
  }
  const starterTemplate = normalizeStarterTemplateId(
    body.starter_template ?? body.starterTemplate,
  );

  const isPrivate = typeof body.private === 'boolean' ? body.private : true;
  const description = normalizeString(body.description);

  let githubAuth: Awaited<ReturnType<typeof resolveGitHubRepoAuth>>;
  try {
    githubAuth = await resolveGitHubRepoAuth(scope.accountId, normalizeString(body.installation_id ?? body.installationId));
  } catch (error) {
    if (error instanceof GitHubInstallationRequiredError) {
      return c.json({
        error: error.message,
        install_url: await createGitHubInstallationInstallUrl(error.accountId, scope.userId),
      }, 409);
    }
    // The account's connection no longer mints tokens — it was made against a
    // different App identity, or somebody uninstalled it.
    if (isGitHubInstallationUnreachable(error)) {
      return c.json(
        githubInstallationUnreachableBody(
          normalizeString(body.installation_id ?? body.installationId) ?? '',
          await createGitHubInstallationInstallUrl(scope.accountId, scope.userId),
        ),
        409,
      );
    }
    // Several connections and no `installation_id`: refuse rather than create
    // the repository under whichever connection happened to sort first.
    if (error instanceof GitHubInstallationAmbiguousError) {
      return c.json({
        error: 'installation_id_required',
        message: error.message,
        installation_ids: error.installationIds,
      }, 409);
    }
    const message = (error as Error).message || 'GitHub is not configured on the server';
    return c.json({ error: message }, 503);
  }
  if (!githubAuth.installation || !githubAuth.auth) {
    return c.json({
      error: 'Install the Kortix GitHub App before creating GitHub-backed projects',
      install_url: await createGitHubInstallationInstallUrl(scope.accountId, scope.userId),
    }, 409);
  }

  // create-repo always provisions a fresh GitHub repo, so block before we
  // create anything upstream — a straight count, no idempotent re-link.
  const createRepoQuota = await enforceProjectQuota(c, scope.accountId);
  if (createRepoQuota) return createRepoQuota;

  // Auto-dedupe name collisions: GitHub 422s when the repo name is taken, so
  // try "name", then "name-2", "name-3", … until one is free (up to 12 tries).
  let repo: Awaited<ReturnType<typeof createRepo>> | undefined;
  let lastRepoError: unknown = null;
  for (let attempt = 0; attempt < 12 && !repo; attempt += 1) {
    const candidate = attempt === 0 ? name : `${name}-${attempt + 1}`;
    try {
      repo = await createRepo({
        name: candidate,
        isPrivate,
        description: description ?? undefined,
        autoInit: true,
        auth: githubAuth.auth,
      });
    } catch (error) {
      lastRepoError = error;
      if (isRepoNameTakenError(error)) continue; // name taken — try the next suffix
      return c.json({ error: (error as Error).message || 'Failed to create GitHub repository' }, 502);
    }
  }
  if (!repo) {
    return c.json(
      {
        error:
          `Could not find an available repository name near "${name}" — too many already exist. ` +
          `Pick a different name. ${(lastRepoError as Error)?.message ?? ''}`.trim(),
      },
      409,
    );
  }

  const projectName = normalizeString(body.project_name ?? body.projectName) ?? deriveProjectName(repo.full_name);
  const defaultBranch = repo.default_branch || 'main';

  // Commit the Kortix starter into the fresh repo so users land with a
  // working project shape on first session boot. GitHub's Contents API
  // updates the branch tip on every write, so these must be sequential.
  // A partial starter is not a usable project.
  const [ownerLogin, repoSlug] = repo.full_name.split('/');
  const starter = sourceItemId
    ? (await buildProjectSeedFilesFromItem({
        id: sourceItemId,
        projectName,
        repoFullName: repo.full_name,
        extraMarketplaceItems: [],
        now: new Date().toISOString(),
      })).files
    : buildStarterFiles({
    projectName,
    repoFullName: repo.full_name,
    template: starterTemplate,
  });
  for (const file of starter) {
    try {
      // README.md exists already from `auto_init: true` — upsert via sha.
      const existingSha = file.path === 'README.md'
        ? await getFileSha({ owner: ownerLogin, repo: repoSlug, path: file.path, branch: defaultBranch, auth: githubAuth.auth })
        : null;
      await commitFile({
        owner: ownerLogin,
        repo: repoSlug,
        path: file.path,
        content: file.content,
        message: `chore: scaffold ${file.path}`,
        branch: defaultBranch,
        existingSha: existingSha ?? undefined,
        auth: githubAuth.auth,
      });
    } catch (err) {
      const message = (err as Error).message || 'Failed to scaffold starter file';
      console.warn(`[projects/create-repo] Failed to scaffold ${file.path} into ${repo.full_name}:`, message);
      return c.json({ error: `Failed to scaffold starter file ${file.path}: ${message}` }, 502);
    }
  }

  const icon = normalizeProjectIcon(body.icon);
  const iconGlyph = normalizeProjectGlyph(body.icon_glyph);
  const row = await registerGitHubLinkedProject({
    accountId: scope.accountId,
    userId: scope.userId,
    repo,
    installation: githubAuth.installation,
    name: projectName,
    defaultBranch,
    managed: true,
    // The starter just committed above (buildStarterFiles) ships kortix.yaml
    // (kortix_version 2) — record that path so it's never stale from birth.
    manifestPath: 'kortix.yaml',
    ...(iconGlyph
      ? { projectMetadata: { icon_glyph: iconGlyph } }
      : icon
        ? { projectMetadata: { icon } }
        : {}),
  });

  kickProjectTemplatePrebuilds(
    {
      projectId: row.projectId,
      repoUrl: row.repoUrl,
      defaultBranch: row.defaultBranch,
      manifestPath: row.manifestPath,
      gitAuthToken: githubAuth.auth?.token ?? null,
    },
    { accountId: scope.accountId, source: 'project-create' },
  );


  // The creator owns the project outright — manager, not the removed middle
  // tier. (Was 'editor' until 2026-08-18; both folded to the same permissions
  // for the creator, who is always an account owner/admin here.)
  return c.json(serializeProject(row, { projectRole: 'manager', effectiveRole: 'manager' }), 201);
},
);
