'use client';

export function useMarketplaceEnabled(workspaceId: string): boolean {
  return !!workspaceId;
}
