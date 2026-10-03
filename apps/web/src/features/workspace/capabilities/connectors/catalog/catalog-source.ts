import type { CatalogSource } from './catalog-entry';

/** Managed is the landing source. Direct API/MCP discovery is explicit. */
export function catalogSource(value: string | null, enabled: boolean): CatalogSource {
  return value === 'direct' && enabled ? 'discover' : 'easy-connect';
}
