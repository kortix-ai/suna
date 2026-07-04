import {
  fetchAccountsWithToken,
  fetchProjectsForAccountWithToken,
  provisionProjectWithToken,
} from '@kortix/sdk/projects-client';

const BACKEND_TIMEOUT_MS = 8_000;
const PROVISION_TIMEOUT_MS = 90_000;

/**
 * For brand-new signups, ensure the personal account has a starter project and
 * return the path to open it. Best-effort — callers fall back to /projects.
 */
export async function resolveFirstProjectPathForNewUser(opts: {
  backendUrl: string;
  accessToken: string;
  isNewUser: boolean;
}): Promise<string | null> {
  if (!opts.isNewUser || !opts.backendUrl || !opts.accessToken) return null;

  const tokenOpts = { backendUrl: opts.backendUrl, accessToken: opts.accessToken };

  const accounts = await fetchAccountsWithToken({ ...tokenOpts, timeoutMs: BACKEND_TIMEOUT_MS });
  const accountId = accounts?.[0]?.account_id;
  if (!accountId) return null;

  const listProjects = () =>
    fetchProjectsForAccountWithToken({ ...tokenOpts, timeoutMs: BACKEND_TIMEOUT_MS }, accountId);

  const existing = await listProjects();
  if (existing && existing.length > 0 && existing[0]?.project_id) {
    return `/projects/${existing[0].project_id}`;
  }

  const result = await provisionProjectWithToken(
    { ...tokenOpts, timeoutMs: PROVISION_TIMEOUT_MS },
    { account_id: accountId, name: 'My First Project', seed_starter: true },
  );

  if (result.ok) {
    if (result.project.project_id) return `/projects/${result.project.project_id}`;
    // A 200 with no project_id is not a usable success — fall through to the
    // safe default (`/projects`) rather than building a broken path.
    return null;
  }

  if (result.limitReached) {
    const retry = await listProjects();
    if (retry?.[0]?.project_id) return `/projects/${retry[0].project_id}`;
  }

  return null;
}
