/**
 * Template install — the one code path both `/v1/templates/*` and the marketplace
 * install route (`/projects/:id/marketplace/install`) use to resolve a
 * `registry:template`, render its `{{inputs}}`, and merge its trigger/connector
 * block into a target manifest. A template IS a marketplace catalog item; this is
 * the template-aware slice of the same install system.
 */

import { executorConnectors } from '@kortix/db';
import { manifestCandidatePaths } from '@kortix/manifest-schema';
import { eq } from 'drizzle-orm';

import { db } from '../../shared/db';

import { findCatalogEntryByName } from '../../marketplace/catalog';
import { buildInstall } from '../../marketplace/install-service';
import { listProjectSecrets } from '../secrets';
import { buildTemplateInstall, parseTemplateBlock } from './apply-template';

/** True if the catalog id resolves to a use-case template (not a plain item). */
export async function isTemplateId(id: string): Promise<boolean> {
  const entry = await findCatalogEntryByName(id);
  return entry?.item.type === 'registry:template';
}

/** Resolve a template, install-plan it, and build against a target manifest. */
export async function previewOrBuild(input: {
  id: string;
  inputs: Record<string, string>;
  context?: Record<string, string>;
  manifestRaw: string | null;
  manifestPath: string;
  existingConnectors: Array<{ slug: string; provider: string }>;
  existingSecretKeys: string[];
}) {
  const entry = await findCatalogEntryByName(input.id);
  if (!entry || entry.item.type !== 'registry:template') return null;

  const built = await buildInstall({
    id: input.id,
    configDir: '.kortix/opencode',
    existingLockRaw: null,
    legacyLockRaw: null,
    now: new Date().toISOString(),
  });

  const result = buildTemplateInstall({
    template: entry.item,
    block: parseTemplateBlock(entry.item),
    registryFiles: built.files,
    capabilities: built.capabilities,
    inputs: input.inputs,
    context: input.context,
    manifestRaw: input.manifestRaw,
    manifestPath: input.manifestPath,
    existingConnectors: input.existingConnectors,
    existingSecretKeys: input.existingSecretKeys,
  });
  return { entry, built, result };
}

/** Template detail for a read surface (the wizard preview + `marketplace show`). */
export async function buildTemplateDetail(id: string) {
  const preview = await previewOrBuild({
    id,
    inputs: {},
    manifestRaw: null,
    manifestPath: 'kortix.yaml',
    existingConnectors: [],
    existingSecretKeys: [],
  });
  if (!preview) return null;
  const { entry, built, result } = preview;
  return {
    id: entry.item.name,
    name: entry.item.name,
    type: 'registry:template' as const,
    title: entry.item.title ?? entry.item.name,
    description: entry.item.description ?? null,
    inputs: entry.item.inputs ?? [],
    requirements: result.requirements,
    installs: built.installed,
    connectors: built.capabilities.connectors,
    secrets: built.capabilities.secrets,
    // Shape-compatible with a marketplace CatalogItem for the CLI resolver.
    dependencies: [] as string[],
    capabilities: built.capabilities,
  };
}

/**
 * Build a template install against a live project — loads the project's manifest
 * connectors + secret keys so the reuse-vs-namespace merge is accurate. Returns
 * `null` when `id` is not a template (the caller falls back to a plain install).
 */
export async function buildTemplateInstallForProject(args: {
  projectId: string;
  projectName: string;
  manifestRaw: string | null;
  manifestPath: string;
  id: string;
  inputs: Record<string, string>;
}) {
  if (!(await isTemplateId(args.id))) return null;

  const connectors = await db
    .select({ slug: executorConnectors.slug, providerType: executorConnectors.providerType })
    .from(executorConnectors)
    .where(eq(executorConnectors.projectId, args.projectId))
    .catch(() => [] as Array<{ slug: string; providerType: unknown }>);
  const secretKeys = Object.keys(await listProjectSecrets(args.projectId).catch(() => ({})));

  return previewOrBuild({
    id: args.id,
    inputs: args.inputs,
    context: { projectName: args.projectName },
    manifestRaw: args.manifestRaw,
    manifestPath: args.manifestPath,
    existingConnectors: connectors.map((cn) => ({ slug: cn.slug, provider: String(cn.providerType) })),
    existingSecretKeys: secretKeys,
  });
}

/** First manifest candidate path for a project's declared manifest path. */
export function primaryManifestPath(manifestPath: string): string {
  return manifestCandidatePaths(manifestPath)[0].path;
}
