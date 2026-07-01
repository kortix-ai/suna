import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  addMarketplaceSource,
  getMarketplaceItem,
  getMarketplaceItemFile,
  getPublicMarketplaceItem,
  getPublicMarketplaceItemFile,
  installMarketplaceItem,
  listFeaturedMarketplaces,
  listInstalledItems,
  listMarketplaceItems,
  listMarketplaces,
  listMarketplaceSources,
  listPublicMarketplaceItems,
  listPublicMarketplaces,
  listRegistryUpdates,
  removeMarketplaceSource,
  uninstallMarketplaceItem,
  updateAllMarketplaceItems,
  updateMarketplaceItem,
  type AddSourceInput,
} from '@/lib/marketplace-client';

export function useMarketplaceItems(params: {
  query?: string;
  type?: string;
  source?: string;
  publicOnly?: boolean;
}) {
  const publicOnly = params.publicOnly ?? false;
  return useQuery({
    queryKey: [
      publicOnly ? 'marketplace-items-public' : 'marketplace-items',
      params.query ?? '',
      params.type ?? 'all',
      params.source ?? 'all',
    ],
    queryFn: () => (publicOnly ? listPublicMarketplaceItems(params) : listMarketplaceItems(params)),
    staleTime: 60_000,
    // While the catalog is still streaming sources in (cold load), re-poll so
    // newly-resolved sources appear without a manual refresh.
    refetchInterval: (query) => (query.state.data?.loading ? 1500 : false),
    // No placeholderData: switching marketplace/type must not flash the previous
    // source's cards under the new header count (they'd disagree). Debounce
    // already coalesces keystrokes, so the skeleton is brief + honest.
  });
}

export function useMarketplaces(opts?: { publicOnly?: boolean }) {
  const publicOnly = opts?.publicOnly ?? false;
  return useQuery({
    queryKey: [publicOnly ? 'marketplaces-public' : 'marketplaces'],
    queryFn: publicOnly ? listPublicMarketplaces : listMarketplaces,
    staleTime: 60_000,
    refetchInterval: (query) => (query.state.data?.loading ? 1500 : false),
  });
}

export function useFeaturedMarketplaces() {
  return useQuery({
    queryKey: ['marketplaces-featured'],
    queryFn: listFeaturedMarketplaces,
    staleTime: 60_000,
  });
}

export function useMarketplaceItem(id: string | null, opts?: { publicOnly?: boolean }) {
  const publicOnly = opts?.publicOnly ?? false;
  return useQuery({
    queryKey: [publicOnly ? 'marketplace-item-public' : 'marketplace-item', id],
    queryFn: () => (publicOnly ? getPublicMarketplaceItem(id!) : getMarketplaceItem(id!)),
    enabled: !!id,
    staleTime: 60_000,
  });
}

export function useMarketplaceItemFile(
  id: string | null,
  target: string | null,
  opts?: { publicOnly?: boolean },
) {
  const publicOnly = opts?.publicOnly ?? false;
  return useQuery({
    queryKey: [publicOnly ? 'marketplace-item-file-public' : 'marketplace-item-file', id, target],
    queryFn: () =>
      publicOnly
        ? getPublicMarketplaceItemFile(id!, target!)
        : getMarketplaceItemFile(id!, target!),
    enabled: !!id && !!target,
    staleTime: 5 * 60_000,
  });
}

export function useInstalledItems(projectId: string | null) {
  return useQuery({
    queryKey: ['marketplace-installed', projectId],
    queryFn: () => listInstalledItems(projectId!),
    enabled: !!projectId,
    staleTime: 30_000,
  });
}

export function useRegistryUpdates(projectId: string | null) {
  return useQuery({
    queryKey: ['marketplace-updates', projectId],
    queryFn: () => listRegistryUpdates(projectId!),
    enabled: !!projectId,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
}

export function useUpdateMarketplaceItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, name }: { projectId: string; name: string }) =>
      updateMarketplaceItem(projectId, name),
    onSuccess: (_data, { projectId }) => {
      qc.invalidateQueries({ queryKey: ['marketplace-installed', projectId] });
      qc.invalidateQueries({ queryKey: ['marketplace-updates', projectId] });
      qc.invalidateQueries({ queryKey: ['project-detail', projectId] });
    },
  });
}

export function useUpdateAllMarketplaceItems() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId }: { projectId: string }) => updateAllMarketplaceItems(projectId),
    onSuccess: (_data, { projectId }) => {
      qc.invalidateQueries({ queryKey: ['marketplace-installed', projectId] });
      qc.invalidateQueries({ queryKey: ['marketplace-updates', projectId] });
      qc.invalidateQueries({ queryKey: ['project-detail', projectId] });
    },
  });
}

export function useInstallMarketplaceItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, id }: { projectId: string; id: string }) =>
      installMarketplaceItem(projectId, id),
    onSuccess: (_data, { projectId }) => {
      qc.invalidateQueries({ queryKey: ['marketplace-installed', projectId] });
      qc.invalidateQueries({ queryKey: ['marketplace-updates', projectId] });
      qc.invalidateQueries({ queryKey: ['project-detail', projectId] });
    },
  });
}

export function useUninstallMarketplaceItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, name }: { projectId: string; name: string }) =>
      uninstallMarketplaceItem(projectId, name),
    onSuccess: (_data, { projectId }) => {
      qc.invalidateQueries({ queryKey: ['marketplace-installed', projectId] });
      qc.invalidateQueries({ queryKey: ['marketplace-updates', projectId] });
      qc.invalidateQueries({ queryKey: ['project-detail', projectId] });
    },
  });
}

// ── "Add a marketplace" sources ─────────────────────────────────────────────

export function useMarketplaceSources(opts?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ['marketplace-sources'],
    queryFn: listMarketplaceSources,
    enabled: opts?.enabled ?? true,
    staleTime: 60_000,
  });
}

export function useAddMarketplaceSource() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: AddSourceInput) => addMarketplaceSource(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['marketplace-sources'] });
      qc.invalidateQueries({ queryKey: ['marketplace-items'] });
      qc.invalidateQueries({ queryKey: ['marketplaces'] });
      qc.invalidateQueries({ queryKey: ['marketplaces-featured'] });
    },
  });
}

export function useRemoveMarketplaceSource() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => removeMarketplaceSource(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['marketplace-sources'] });
      qc.invalidateQueries({ queryKey: ['marketplace-items'] });
      qc.invalidateQueries({ queryKey: ['marketplaces'] });
      qc.invalidateQueries({ queryKey: ['marketplaces-featured'] });
    },
  });
}
