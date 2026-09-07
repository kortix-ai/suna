'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import {
  type ListTemplateCatalogOptions,
  type Template,
  type TemplateListing,
  createTemplateInstallSession,
  getTemplateBySlug,
  listTemplateCatalog,
} from '../core/rest/projects-client';
import { contract } from './query-contracts';
import { qk } from './query-keys';

/** Stable key factories — reuse to read or invalidate the same cache entries. */
export const templateCatalogKey = (options?: ListTemplateCatalogOptions) =>
  qk.templates.list(options);
export const templateKey = (slug: string) => qk.templates.detail(slug);

/** The template catalog. Public: needs no project and no token. */
export function useTemplateCatalog(options?: ListTemplateCatalogOptions) {
  return useQuery<TemplateListing>({
    queryKey: templateCatalogKey(options),
    queryFn: () => listTemplateCatalog(options),
    ...contract('config'),
  });
}

/** One template's detail, by slug. */
export function useTemplate(slug: string | null | undefined) {
  return useQuery<Template>({
    queryKey: templateKey(slug ?? ''),
    queryFn: () => getTemplateBySlug(slug as string),
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
export function useTemplateInstall(projectId: string | null | undefined) {
  return useMutation({
    mutationFn: (slug: string) => createTemplateInstallSession(projectId as string, slug),
  });
}
