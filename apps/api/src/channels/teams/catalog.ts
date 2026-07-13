import { buildTeamsAppPackage } from './app-package';

const CATALOG_URL = 'https://graph.microsoft.com/v1.0/appCatalogs/teamsApps';

export interface PublishResult {
  ok: boolean;
  published: boolean;
  pendingReview?: boolean;
  teamsAppId?: string;
  error?: string;
}

function postPackage(url: string, zip: Buffer, accessToken: string): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/zip' },
    body: new Uint8Array(zip),
    signal: AbortSignal.timeout(30_000),
  });
}

async function lookupCatalogAppId(accessToken: string, externalId: string): Promise<string | undefined> {
  try {
    const url = `${CATALOG_URL}?$filter=externalId eq '${encodeURIComponent(externalId)}'`;
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { value?: Array<{ id?: string }> };
    return body.value?.[0]?.id;
  } catch {
    return undefined;
  }
}

async function firstId(res: Response): Promise<string | undefined> {
  const body = (await res.json().catch(() => ({}))) as { id?: string };
  return body.id;
}

/**
 * Publish the Teams app package to the tenant's org app catalog using a
 * DELEGATED admin token. `POST /appCatalogs/teamsApps` does not support
 * app-only auth — a signed-in admin is required (see teamsapp-publish docs).
 * A Teams admin publishes immediately; a non-admin's package is submitted for
 * admin review (`requiresReview=true`) instead. `appId` is the manifest id,
 * which becomes the catalog `externalId` we look installs up by.
 */
export async function publishTeamsAppToCatalog(input: {
  accessToken: string;
  baseUrl: string;
  appId: string;
  appName?: string;
}): Promise<PublishResult> {
  const zip = buildTeamsAppPackage({
    appId: input.appId,
    baseUrl: input.baseUrl,
    appName: input.appName,
    botName: input.appName,
  });

  let res: Response;
  try {
    res = await postPackage(CATALOG_URL, zip, input.accessToken);
  } catch (err) {
    return { ok: false, published: false, error: (err as Error)?.message ?? 'graph request failed' };
  }

  if (res.status === 201) {
    return { ok: true, published: true, teamsAppId: await firstId(res) };
  }
  if (res.status === 409) {
    const id = await lookupCatalogAppId(input.accessToken, input.appId);
    return { ok: true, published: true, teamsAppId: id };
  }
  if (res.status === 403) {
    let rev: Response;
    try {
      rev = await postPackage(`${CATALOG_URL}?requiresReview=true`, zip, input.accessToken);
    } catch (err) {
      return { ok: false, published: false, error: (err as Error)?.message ?? 'graph review request failed' };
    }
    if (rev.status === 201 || rev.status === 202) {
      return { ok: true, published: false, pendingReview: true, teamsAppId: await firstId(rev) };
    }
    if (rev.status === 409) {
      const id = await lookupCatalogAppId(input.accessToken, input.appId);
      return { ok: true, published: true, teamsAppId: id };
    }
    const text = await rev.text().catch(() => '');
    console.warn('[teams-catalog] review submit failed', { status: rev.status, body: text.slice(0, 300) });
    return { ok: false, published: false, error: `Graph app-catalog review submit failed (${rev.status})` };
  }
  const text = await res.text().catch(() => '');
  console.warn('[teams-catalog] publish failed', { status: res.status, body: text.slice(0, 300) });
  return { ok: false, published: false, error: `Graph app-catalog publish failed (${res.status})` };
}
