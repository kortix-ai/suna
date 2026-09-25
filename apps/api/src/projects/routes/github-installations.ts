/** Account GitHub App installations: read, list, link, and unlink. */
import { ACCOUNT_ACTIONS, assertAuthorized, authorize } from '../../iam';
import { actorOf } from '../../iam/actor';
import { auth, errors, json } from '../../openapi';
import { db } from '../../shared/db';
import {
  getGitHubAppInstallation,
  githubVerificationStatus,
  listLinkableGitHubAppInstallations,
  type GitHubAppInstallation,
  verifyGitHubAppInstallStatePayload,
  verifyGitHubInstallationAdmin,
} from '../github';
import { createRoute, z } from '@hono/zod-openapi';
import { accountGithubInstallations } from '@kortix/db';
import { and, eq, ne } from 'drizzle-orm';
import { resolveProjectAccount } from '../lib/access';
import { AnyObject, projectsApp } from '../lib/app';
import {
  consumeGitHubInstallationState,
  countInstallationsLinkedToOtherAccounts,
  createGitHubInstallationInstallUrl,
  getAccountGitHubInstallation,
  listAccountGitHubInstallations,
} from '../lib/git';
import {
  normalizeString,
  serializeGitHubInstallation,
  serializeGitHubInstallations,
} from '../lib/serializers';
import { readJsonObject } from '../../shared/http-body';

// GET /v1/projects/github/installation?account_id=...
// Account-scoped GitHub App install state. The client only receives metadata;
// installation tokens are minted server-side at repo creation time.

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/github/installation',
    tags: ['github'],
    summary: 'GET /github/installation',
    ...auth,
    responses: {
        200: json(z.any(), 'OK'),
    },
  }),
  async (c: any) => {
  const scope = await resolveProjectAccount(c);
  await assertAuthorized(await actorOf(c, scope.accountId), ACCOUNT_ACTIONS.PROJECT_CREATE);

  const rows = await listAccountGitHubInstallations(scope.accountId);
  const canManageGit = (await authorize(await actorOf(c, scope.accountId), ACCOUNT_ACTIONS.ACCOUNT_WRITE)).allowed;
  const installUrl = canManageGit
    ? await createGitHubInstallationInstallUrl(scope.accountId, scope.userId)
    : null;
  // Account connections only. "Kortix managed" is the INSTANCE backend and
  // has its own namespace (GET /v1/projects/git/backend[/repositories]); it
  // used to appear here as a synthetic installation, which made an
  // instance-global credential look like this account's own connection.
  return c.json(serializeGitHubInstallations(rows, scope.accountId, installUrl));
},
);

// GET /v1/projects/github/installations?account_id=...
// Vercel-style account Git connections surface. A Kortix account can connect
// multiple GitHub users/orgs and pick the exact installation during import.

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/github/installations',
    tags: ['github'],
    summary: 'GET /github/installations',
    ...auth,
    responses: {
        200: json(z.any(), 'OK'),
    },
  }),
  async (c: any) => {
  const scope = await resolveProjectAccount(c);
  await assertAuthorized(await actorOf(c, scope.accountId), ACCOUNT_ACTIONS.PROJECT_CREATE);

  const rows = await listAccountGitHubInstallations(scope.accountId);
  const canManageGit = (await authorize(await actorOf(c, scope.accountId), ACCOUNT_ACTIONS.ACCOUNT_WRITE)).allowed;
  const installUrl = canManageGit
    ? await createGitHubInstallationInstallUrl(scope.accountId, scope.userId)
    : null;
  // Account connections only. "Kortix managed" is the INSTANCE backend and
  // has its own namespace (GET /v1/projects/git/backend[/repositories]); it
  // used to appear here as a synthetic installation, which made an
  // instance-global credential look like this account's own connection.
  return c.json(serializeGitHubInstallations(rows, scope.accountId, installUrl));
},
);

/**
 * One row per `(account_id, owner_login)`.
 *
 * Reconnecting the App mints a NEW installation id for the same owner, and the
 * retired id answers 404 on `/access_tokens` forever after. Conflicting on
 * `(account_id, installation_id)` alone left both rows in place, both labelled
 * `github.com/<owner>`, and a create could pick the dead one — which is how a
 * user who had just reconnected was told to reconnect (prod, 2026-09-25).
 *
 * The delete and the insert share one transaction: a reader never sees an
 * account with zero connections to an owner it is connected to.
 *
 * Exported for `__tests__/integration-github-installation-dedupe.test.ts`,
 * which drives it against the real table.
 */
export async function upsertAccountGitHubInstallation(
  accountId: string,
  installationId: string,
  installation: GitHubAppInstallation,
) {
  const ownerLogin = normalizeString(installation.account?.login);
  if (!ownerLogin) {
    throw new Error('GitHub installation did not include an owner account');
  }

  const ownerType =
    normalizeString(installation.account?.type) ?? installation.target_type ?? 'Organization';
  const now = new Date();
  const row = await db.transaction(async (tx) => {
    await tx
      .delete(accountGithubInstallations)
      .where(
        and(
          eq(accountGithubInstallations.accountId, accountId),
          eq(accountGithubInstallations.ownerLogin, ownerLogin),
          ne(accountGithubInstallations.installationId, installationId),
        ),
      );
    const [inserted] = await tx
      .insert(accountGithubInstallations)
      .values({
        accountId,
        installationId,
        ownerLogin,
        ownerType,
        repositorySelection: installation.repository_selection ?? null,
        permissions: installation.permissions ?? {},
        metadata: {
          html_url: installation.html_url ?? null,
        },
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [accountGithubInstallations.accountId, accountGithubInstallations.installationId],
        set: {
          ownerLogin,
          ownerType,
          repositorySelection: installation.repository_selection ?? null,
          permissions: installation.permissions ?? {},
          metadata: {
            html_url: installation.html_url ?? null,
          },
          updatedAt: now,
        },
      })
      .returning();
    return inserted;
  });

  if (!row) throw new Error('Failed to save the GitHub installation');
  return row;
}

// POST /v1/projects/github/installations/linkable
// The GitHub OAuth token cannot call GET /user/installations. GitHub restricts
// that route to GitHub App user tokens. Kortix lists this App's installations
// with the App JWT, then filters them with the authorized user's identity and
// active organization-admin memberships.

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/github/installations/linkable',
    tags: ['github'],
    summary: 'POST /github/installations/linkable',
    ...auth,
    request: {
      body: { content: { 'application/json': { schema: AnyObject } } },
    },
    responses: {
      200: json(z.any(), 'Linkable GitHub App installations'),
      ...errors(400, 403, 502),
    },
  }),
  async (c: any) => {
    const body = await readJsonObject(c);
    const scope = await resolveProjectAccount(c, body);
    await assertAuthorized(await actorOf(c, scope.accountId), ACCOUNT_ACTIONS.ACCOUNT_WRITE);

    const githubUserToken = normalizeString(body.github_user_token ?? body.githubUserToken);
    if (!githubUserToken) {
      return c.json({ error: 'GitHub authorization is required to list installations' }, 400);
    }

    let linkable;
    try {
      linkable = await listLinkableGitHubAppInstallations(githubUserToken);
    } catch (error) {
      return c.json(
        {
          error: (error as Error).message || 'Failed to list GitHub App installations',
        },
        502,
      );
    }

    const linkedRows = await listAccountGitHubInstallations(scope.accountId);
    const linkedIds = new Set(linkedRows.map((row) => row.installationId));
    const installUrl = await createGitHubInstallationInstallUrl(scope.accountId, scope.userId);
    const otherAccountCounts = await countInstallationsLinkedToOtherAccounts(
      scope.accountId,
      linkable.installations.map((installation) => String(installation.id)),
    );

    return c.json({
      account_id: scope.accountId,
      github_login: linkable.githubLogin,
      configured: Boolean(installUrl),
      install_url: installUrl,
      installations: linkable.installations.map((installation) => ({
        installation_id: String(installation.id),
        owner_login: installation.account?.login ?? null,
        owner_type: installation.account?.type ?? installation.target_type ?? null,
        repository_selection: installation.repository_selection ?? null,
        permissions: installation.permissions ?? {},
        installation_url: installation.html_url ?? null,
        linked: linkedIds.has(String(installation.id)),
        // A COUNT, never a name. Which other tenants hold this installation is
        // their business; that it is shared is this caller's.
        linked_to_other_accounts: otherAccountCounts.get(String(installation.id)) ?? 0,
      })),
    });
  },
);

// POST /v1/projects/github/installations/link
// This same-origin path links an existing App installation without a GitHub
// install callback. The API verifies the installation against the App JWT and
// verifies the authorized GitHub user again before it writes the account row.

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/github/installations/link',
    tags: ['github'],
    summary: 'POST /github/installations/link',
    ...auth,
    request: {
      body: { content: { 'application/json': { schema: AnyObject } } },
    },
    responses: {
      200: json(z.any(), 'Linked GitHub App installation'),
      ...errors(400, 403, 502),
    },
  }),
  async (c: any) => {
    const body = await readJsonObject(c);
    const scope = await resolveProjectAccount(c, body);
    await assertAuthorized(await actorOf(c, scope.accountId), ACCOUNT_ACTIONS.ACCOUNT_WRITE);

    const installationId = normalizeString(body.installation_id ?? body.installationId);
    if (!installationId) return c.json({ error: 'installation_id is required' }, 400);
    if (!/^[0-9]+$/.test(installationId)) {
      return c.json({ error: 'installation_id must be a GitHub installation id' }, 400);
    }
    const githubUserToken = normalizeString(body.github_user_token ?? body.githubUserToken);
    if (!githubUserToken) {
      return c.json({ error: 'GitHub authorization is required to link this installation' }, 400);
    }

    let installation: GitHubAppInstallation;
    try {
      installation = await getGitHubAppInstallation(installationId);
    } catch (error) {
      return c.json(
        {
          error: (error as Error).message || 'Failed to verify GitHub App installation',
        },
        502,
      );
    }

    try {
      await verifyGitHubInstallationAdmin(githubUserToken, installation);
    } catch (error) {
      return c.json(
        {
          error: (error as Error).message || 'GitHub administrator verification failed',
        },
        githubVerificationStatus(error),
      );
    }

    try {
      const row = await upsertAccountGitHubInstallation(
        scope.accountId,
        installationId,
        installation,
      );
      return c.json(serializeGitHubInstallation(row, scope.accountId, null), 200);
    } catch (error) {
      return c.json(
        {
          error: (error as Error).message || 'Failed to save the GitHub installation',
        },
        502,
      );
    }
  },
);

// POST /v1/projects/github/installation
// Called after GitHub redirects back with installation_id + signed state.
// We fetch installation metadata with the app JWT instead of trusting client
// supplied owner information.

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/github/installation',
    tags: ['github'],
    summary: 'POST /github/installation',
    ...auth,
      request: {
        body: { content: { 'application/json': { schema: AnyObject } } },
      },
    responses: {
        200: json(z.any(), 'OK'),
        ...errors(400, 403, 502),
    },
  }),
  async (c: any) => {
  const body = await readJsonObject(c);
  const state = normalizeString(body.state);
  if (!state) return c.json({ error: 'state is required' }, 400);
  const statePayload = verifyGitHubAppInstallStatePayload(state);
  if (!statePayload?.accountId || !statePayload.nonce) {
    return c.json({ error: 'invalid GitHub installation state' }, 400);
  }

  const scope = await resolveProjectAccount(c, { account_id: statePayload.accountId });
  await assertAuthorized(await actorOf(c, scope.accountId), ACCOUNT_ACTIONS.ACCOUNT_WRITE);

  const installationId = normalizeString(body.installation_id ?? body.installationId);
  if (!installationId) return c.json({ error: 'installation_id is required' }, 400);
  if (!/^[0-9]+$/.test(installationId)) {
    return c.json({ error: 'installation_id must be a GitHub installation id' }, 400);
  }
  const githubUserToken = normalizeString(body.github_user_token ?? body.githubUserToken);
  if (!githubUserToken) {
    return c.json({ error: 'GitHub authorization is required to link this installation' }, 400);
  }

  let installation;
  try {
    installation = await getGitHubAppInstallation(installationId);
  } catch (error) {
    const message = (error as Error).message || 'Failed to verify GitHub App installation';
    return c.json({ error: message }, 502);
  }

  try {
    await verifyGitHubInstallationAdmin(githubUserToken, installation);
  } catch (error) {
    const message = (error as Error).message || 'GitHub administrator verification failed';
    return c.json({ error: message }, githubVerificationStatus(error));
  }

  const stateStatus = await consumeGitHubInstallationState({
    accountId: scope.accountId,
    userId: scope.userId,
    nonce: statePayload.nonce,
    installationId,
  });
  if (stateStatus === 'invalid') {
    const existing = await getAccountGitHubInstallation(scope.accountId, installationId);
    if (existing?.installationId === installationId) {
      return c.json(serializeGitHubInstallation(existing, scope.accountId, null), 200);
    }
    return c.json({ error: 'GitHub installation state is expired or already used' }, 400);
  }

  try {
    const row = await upsertAccountGitHubInstallation(
      scope.accountId,
      installationId,
      installation,
    );
    return c.json(serializeGitHubInstallation(row, scope.accountId, null), 200);
  } catch (error) {
    return c.json(
      {
        error: (error as Error).message || 'Failed to save the GitHub installation',
      },
      502,
    );
  }
},
);

// DELETE /v1/projects/github/installation?account_id=...

projectsApp.openapi(
  createRoute({
    method: 'delete',
    path: '/github/installation',
    tags: ['github'],
    summary: 'DELETE /github/installation',
    ...auth,
      request: {
        query: z.object({}).passthrough(),
      },
    responses: {
        200: json(z.any(), 'OK'),
    },
  }),
  async (c: any) => {
  const scope = await resolveProjectAccount(c);
  await assertAuthorized(await actorOf(c, scope.accountId), ACCOUNT_ACTIONS.ACCOUNT_WRITE);
  const installationId = normalizeString(c.req.query('installation_id') ?? c.req.query('installationId'));

  await db
    .delete(accountGithubInstallations)
    .where(installationId
      ? and(
          eq(accountGithubInstallations.accountId, scope.accountId),
          eq(accountGithubInstallations.installationId, installationId),
        )
      : eq(accountGithubInstallations.accountId, scope.accountId));

  return c.json({ ok: true });
},
);

// DELETE /v1/projects/github/installations/:installationId?account_id=...

projectsApp.openapi(
  createRoute({
    method: 'delete',
    path: '/github/installations/{installationId}',
    tags: ['github'],
    summary: 'DELETE /github/installations/:installationId',
    ...auth,
      request: {
        params: z.object({ installationId: z.string() }),
      },
    responses: {
        200: json(z.any(), 'OK'),
    },
  }),
  async (c: any) => {
  const scope = await resolveProjectAccount(c);
  await assertAuthorized(await actorOf(c, scope.accountId), ACCOUNT_ACTIONS.ACCOUNT_WRITE);
  const installationId = c.req.param('installationId');

  await db
    .delete(accountGithubInstallations)
    .where(and(
      eq(accountGithubInstallations.accountId, scope.accountId),
      eq(accountGithubInstallations.installationId, installationId),
    ));

  return c.json({ ok: true });
},
);
