/**
 * Forward-facing provider label, and whether a provider's accounts sign in
 * through a managed partner. Both live in `@kortix/sdk`
 * (`core/connectors/connector-status`), which the TUI reads too.
 */
export {
  connectorProviderLabel as providerLabel,
  isManagedConnectorProvider,
} from '@kortix/sdk';

/** Whether a Composio connection has completed provider authorization. */
export function composioConnectionIsAuthorized(
  metadata: Record<string, unknown> | null | undefined,
): boolean {
  if (metadata?.provider !== 'composio') return false;
  const sessionId = metadata.session_id;
  if (typeof sessionId !== 'string' || sessionId.trim().length === 0) return false;
  if (metadata.is_no_auth === true) return true;
  const accountId = metadata.connected_account_id;
  return typeof accountId === 'string' && accountId.trim().length > 0;
}
