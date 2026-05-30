/**
 * LSS semantic search — stubbed for project-files (read-only).
 *
 * The instance feature hits the per-sandbox Kortix Master `/lss/search`
 * endpoint; project view has no sandbox, so no semantic index is reachable.
 *
 * TODO: wire to project history/search once backend supports it
 */

import type { LssHit } from '../types';

export async function searchLss(
  _query: string,
  _options?: { limit?: number },
): Promise<LssHit[]> {
  return [];
}
