import type { ItemCapabilities } from '@/lib/marketplace-client';

/** True when an item exposes any secrets/connectors/tools it needs — used to
 *  decide whether the modal renders the capabilities panel at all. */
export function hasCapabilities(caps: ItemCapabilities | null | undefined): boolean {
  return !!caps && caps.secrets.length + caps.connectors.length + caps.tools.length > 0;
}

/** Total capability count across all three kinds, for the section's count
 *  badge. */
export function capabilityCount(caps: ItemCapabilities | null | undefined): number {
  if (!caps) return 0;
  return caps.secrets.length + caps.connectors.length + caps.tools.length;
}
