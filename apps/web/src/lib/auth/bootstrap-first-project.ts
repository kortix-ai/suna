const BACKEND_TIMEOUT_MS = 8_000;
const PROVISION_TIMEOUT_MS = 90_000;

function normalizeBackendBase(backendUrl: string): string {
  return backendUrl.replace(/\/v1\/?$/, '');
}

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

  const base = normalizeBackendBase(opts.backendUrl);
  const headers = {
    Authorization: `Bearer ${opts.accessToken}`,
    'Content-Type': 'application/json',
  };

  const accountsRes = await fetch(`${base}/v1/accounts`, {
    headers,
    signal: AbortSignal.timeout(BACKEND_TIMEOUT_MS),
  });
  if (!accountsRes.ok) return null;

  const accounts = (await accountsRes.json()) as Array<{ account_id?: string }>;
  const accountId = accounts[0]?.account_id;
  if (!accountId) return null;

  const projectsPath = `${base}/v1/projects?account_id=${encodeURIComponent(accountId)}`;
  const listProjects = async () => {
    const res = await fetch(projectsPath, {
      headers,
      signal: AbortSignal.timeout(BACKEND_TIMEOUT_MS),
    });
    if (!res.ok) return [] as Array<{ project_id?: string }>;
    return (await res.json()) as Array<{ project_id?: string }>;
  };

  const existing = await listProjects();
  if (existing.length > 0 && existing[0]?.project_id) {
    return `/projects/${existing[0].project_id}`;
  }

  const provisionRes = await fetch(`${base}/v1/projects/provision`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      account_id: accountId,
      name: 'My First Project',
      seed_starter: true,
    }),
    signal: AbortSignal.timeout(PROVISION_TIMEOUT_MS),
  });

  if (provisionRes.ok) {
    const project = (await provisionRes.json()) as { project_id?: string };
    if (project.project_id) return `/projects/${project.project_id}`;
  }

  if (provisionRes.status === 403) {
    const body = (await provisionRes.json().catch(() => null)) as {
      code?: string;
    } | null;
    if (body?.code === 'project_limit_reached') {
      const retry = await listProjects();
      if (retry[0]?.project_id) return `/projects/${retry[0].project_id}`;
    }
  }

  return null;
}
