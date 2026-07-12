import { graphToken } from '../teams-auth';
import { buildTeamsAppPackage } from './app-package';

const CATALOG_URL = 'https://graph.microsoft.com/v1.0/appCatalogs/teamsApps';

export async function publishTeamsAppToCatalog(input: {
  tenantId: string;
  baseUrl: string;
  appId: string;
  appName?: string;
}): Promise<{ ok: boolean; teamsAppId?: string; error?: string }> {
  const token = await graphToken(input.tenantId).catch(() => null);
  if (!token) return { ok: false, error: 'could not mint a Graph token for the tenant' };

  const zip = buildTeamsAppPackage({ appId: input.appId, baseUrl: input.baseUrl, appName: input.appName, botName: input.appName });
  let res: Response;
  try {
    res = await fetch(CATALOG_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/zip' },
      body: new Uint8Array(zip),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    return { ok: false, error: (err as Error)?.message ?? 'graph request failed' };
  }

  if (res.status === 201) {
    const body = (await res.json().catch(() => ({}))) as { id?: string };
    return { ok: true, teamsAppId: body.id };
  }
  if (res.status === 409) return { ok: true };
  const text = await res.text().catch(() => '');
  console.warn('[teams-catalog] publish failed', { status: res.status, body: text.slice(0, 300) });
  return { ok: false, error: `Graph app-catalog publish failed (${res.status})` };
}
