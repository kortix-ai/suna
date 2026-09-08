'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import {
  type ListTemplateCatalogOptions,
  type Template,
  type TemplateFileListing,
  type TemplateListing,
  createTemplateInstallSession,
  getTemplateBySlug,
  listTemplateCatalog,
  listTemplateFiles,
  readTemplateFile,
} from '../core/rest/projects-client';
import { contract } from './query-contracts';
import { qk } from './query-keys';

/** Stable key factories — reuse to read or invalidate the same cache entries. */
export const templateCatalogKey = (options?: ListTemplateCatalogOptions) =>
  qk.templates.list(options);
export const templateKey = (slug: string) => qk.templates.detail(slug);
export const templateFilesKey = (slug: string) => qk.templates.files(slug);
export const templateFileKey = (slug: string, path: string) => qk.templates.file(slug, path);

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

/** The template repository's file tree, at its pinned commit. */
export function useTemplateFiles(slug: string | null | undefined) {
  return useQuery<TemplateFileListing>({
    queryKey: templateFilesKey(slug ?? ''),
    queryFn: () => listTemplateFiles(slug as string),
    enabled: !!slug,
    ...contract('config'),
  });
}

/**
 * One file's text.
 *
 * `initialData` is how the detail page hands over the README it already
 * server-rendered: the default file must not flash a spinner on a page whose
 * whole point is that its primary document is in the HTML.
 */
export function useTemplateFile(
  slug: string | null | undefined,
  path: string | null | undefined,
  options?: { initialData?: string },
) {
  return useQuery<string>({
    queryKey: templateFileKey(slug ?? '', path ?? ''),
    queryFn: () => readTemplateFile(slug as string, path as string),
    enabled: !!slug && !!path,
    initialData: options?.initialData,
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
