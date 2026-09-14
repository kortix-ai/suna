import type { AdminConnector } from '@kortix/sdk';

/**
 * Forward-facing provider label — "App" for the 1-click (Pipedream) connectors.
 *
 * Lives here, in the connectors feature folder, rather than in
 * `customize/sections/connectors-view.tsx` where it started. That module is
 * 5,219 lines and 50 components; exporting this plain function beside them took
 * the whole file off React Fast Refresh's hot path (every edit = full page
 * reload), and importing this six-line switch from it dragged the entire module
 * — plus `@pipedream/sdk/browser`, `HighlightedCode`, `PoliciesPanel` — into
 * the `/projects/[id]/connectors` route chunk.
 *
 * The legacy Customize surface imports it back from here. That direction is
 * deliberate: when `connectors-view.tsx` is retired, this module does not move.
 */
export function providerLabel(p: AdminConnector['provider']): string {
  if (isManagedConnectorProvider(p)) return 'App';
  if (p === 'channel') return 'Channel';
  if (p === 'computer') return 'Computer Tunnel';
  if (p === 'postman') return 'Postman';
  return p.toUpperCase();
}

/** Providers whose accounts are authorized through the normalized Connect Link gateway. */
export function isManagedConnectorProvider(p: AdminConnector['provider']): boolean {
  return p === 'composio' || p === 'pipedream';
}

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
