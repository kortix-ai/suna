/**
 * Whether finishing an OAuth connection should re-fetch the connector's
 * catalog, and with which arguments.
 *
 * An MCP catalog is fetched WITH the connector credential. When a connector is
 * created before it is authorized, that first fetch is a 401 and the row keeps
 * `status: 'error'`. Completing the OAuth flow is exactly the moment the
 * credential starts to exist, so it is also the moment the catalog becomes
 * fetchable — nothing else re-runs it, and the user is left staring at "Error"
 * on a connector they just connected successfully.
 *
 * The eligibility rule mirrors `rematerializeCatalogAfterCredentialUpdate`:
 * `connector_actions` is ONE project-wide catalog, so only a project-owned
 * default connection may publish it. A member's personal connection can expose
 * tenant-specific tools and must never write them for everyone else.
 */
export interface OAuthCompletionRematerializeInput {
  projectId: string;
  accountId: string;
  connectorId: string;
  providerType: string;
  ownerType: string;
  isDefault: boolean;
}

export function oauthCompletionRematerializeInput(input: OAuthCompletionRematerializeInput): {
  projectId: string;
  accountId: string;
  provider: string;
  ownerType: string;
  isDefault: boolean;
  connectorId: string;
} | null {
  if (input.providerType !== 'mcp' || input.ownerType !== 'project' || !input.isDefault) {
    return null;
  }
  return {
    projectId: input.projectId,
    accountId: input.accountId,
    provider: input.providerType,
    ownerType: input.ownerType,
    isDefault: input.isDefault,
    connectorId: input.connectorId,
  };
}
