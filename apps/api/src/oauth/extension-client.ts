/** Which OAuth client is the verified Kortix in Chrome extension. */
import { and, eq } from 'drizzle-orm';
import { oauthClients } from '@kortix/db';
import { db } from '../shared/db';
import { isUuid } from '../shared/validate';

/**
 * The Kortix in Chrome extension registers itself on each install. Only the
 * extension with this id serves a `chrome-extension://<id>/` page, and our
 * signing key pins the id, so a client that can only redirect there is ours.
 */
export const KORTIX_EXTENSION_REDIRECT_URI = 'chrome-extension://gefbbnjgoiljpbnalgafbhbfdhikgjek/welcome.html';

/** True when the client's only redirect URI is the extension's. */
export function hasOnlyExtensionRedirect(redirectUris: readonly string[] | null | undefined): boolean {
  return redirectUris?.length === 1 && redirectUris[0] === KORTIX_EXTENSION_REDIRECT_URI;
}

export async function isKortixExtensionClient(clientId: string | undefined): Promise<boolean> {
  if (!clientId || !isUuid(clientId)) return false;
  const [client] = await db
    .select({ redirectUris: oauthClients.redirectUris })
    .from(oauthClients)
    .where(and(eq(oauthClients.clientId, clientId), eq(oauthClients.active, true)))
    .limit(1);
  return hasOnlyExtensionRedirect(client?.redirectUris);
}
