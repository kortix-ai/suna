import type { AdminConnector } from '@kortix/sdk';

type ConnectorReadinessInput = Pick<
  AdminConnector,
  'provider' | 'status' | 'authorizationStrategy' | 'authSecret' | 'secretSet'
>;

export function connectorConnectionIsReady(
  connector: ConnectorReadinessInput,
  hasStrategyConnection: boolean,
): boolean {
  if (connector.status !== 'active') return false;
  if (connector.provider === 'composio') return hasStrategyConnection;
  if (!connector.authSecret) return true;
  if (connector.authorizationStrategy === 'user') return hasStrategyConnection;
  return connector.secretSet;
}

/**
 * Which of an app's published surfaces to lead with.
 *
 * MCP wins whenever it is addable (COR-17): its auth chain — OAuth discovery
 * plus RFC 7591 dynamic client registration — connects in one click on
 * servers that support it, which no other surface kind can offer. A surface
 * without a `connector` template cannot be added from here at all, so it
 * never wins over one that can. Falls back to the first addable surface,
 * then the first surface, preserving feed order.
 */
export function recommendedSurfaceVariant<
  V extends { kind: string; connector: unknown | null },
>(variants: readonly V[]): V | null {
  return (
    variants.find((variant) => variant.kind === 'mcp' && variant.connector) ??
    variants.find((variant) => variant.connector) ??
    variants[0] ??
    null
  );
}

/**
 * The full surface list with the recommended one first — a stable move-to-
 * front, so everything else keeps its feed order.
 */
export function surfacesRecommendedFirst<
  V extends { kind: string; connector: unknown | null },
>(variants: readonly V[]): V[] {
  const recommended = recommendedSurfaceVariant(variants);
  if (!recommended) return [...variants];
  return [recommended, ...variants.filter((variant) => variant !== recommended)];
}
