import { accountTokens, oauthClients } from '@kortix/db';
import { inArray } from 'drizzle-orm';
import { db } from './db';
import { isUuid } from './validate';

type Row = { credentialKind: string | null; credentialId: string | null };

/**
 * Display names for the credentials on a page of audit rows: the PAT's name,
 * the connected app's name. Keyed `<kind>:<id>`. A deleted credential has no
 * entry; the row still says its kind. Two indexed lookups per page, at most.
 */
export async function auditCredentialNames(rows: Row[]): Promise<Map<string, string>> {
  const ids = (kind: string) => [
    ...new Set(
      rows
        .filter((r) => r.credentialKind === kind && isUuid(r.credentialId))
        .map((r) => r.credentialId as string),
    ),
  ];
  const pats = ids('personal_access_token');
  const apps = ids('oauth_app');
  const names = new Map<string, string>();
  const [patRows, appRows] = await Promise.all([
    pats.length
      ? db
          .select({ id: accountTokens.tokenId, name: accountTokens.name })
          .from(accountTokens)
          .where(inArray(accountTokens.tokenId, pats))
      : [],
    apps.length
      ? db
          .select({ id: oauthClients.clientId, name: oauthClients.name })
          .from(oauthClients)
          .where(inArray(oauthClients.clientId, apps))
      : [],
  ]);
  for (const r of patRows) names.set(`personal_access_token:${r.id}`, r.name);
  for (const r of appRows) names.set(`oauth_app:${r.id}`, r.name);
  return names;
}
