'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import {
  type ListMarketplaceTemplatesOptions,
  type MarketplaceTemplate,
  type MarketplaceTemplateListing,
  createMarketplaceInstallSession,
  getMarketplaceTemplate,
  listMarketplaceTemplates,
} from '../core/rest/projects-client';
import { contract } from './query-contracts';
import { qk } from './query-keys';

/** Stable key factories — reuse to read or invalidate the same cache entries. */
export const marketplaceTemplatesKey = (options?: ListMarketplaceTemplatesOptions) =>
  qk.marketplace.list(options);
export const marketplaceTemplateKey = (slug: string) => qk.marketplace.detail(slug);

/** The template catalog. Public: needs no project and no token. */
export function useMarketplaceTemplates(options?: ListMarketplaceTemplatesOptions) {
  return useQuery<MarketplaceTemplateListing>({
    queryKey: marketplaceTemplatesKey(options),
    queryFn: () => listMarketplaceTemplates(options),
    ...contract('config'),
  });
}

/** One template's detail, by slug. */
export function useMarketplaceTemplate(slug: string | null | undefined) {
  return useQuery<MarketplaceTemplate>({
    queryKey: marketplaceTemplateKey(slug ?? ''),
    queryFn: () => getMarketplaceTemplate(slug as string),
    enabled: !!slug,
    ...contract('config'),
  });
}

/**
 * Start the agent-driven install of one template into a project.
 *
 * Resolves to a SESSION id — the agent inside it does the merge and lands a
 * change request, so nothing has been installed when the promise resolves.
 * There is no installed list to invalidate: the change request is the record.
 */
export function useMarketplaceInstall(projectId: string | null | undefined) {
  return useMutation({
    mutationFn: (slug: string) => createMarketplaceInstallSession(projectId as string, slug),
  });
}
