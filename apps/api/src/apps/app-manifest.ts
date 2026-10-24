/**
 * kortix.yaml owns every App field it can declare (`apps.<slug>`): size
 * (`resources`), `idle_timeout_seconds`, `always_on`, `labels`, `display`
 * and `uses`. Two rules keep the App row and the file from disagreeing:
 *
 * - A write of one of these fields commits it to kortix.yaml first
 *   ({@link commitAppFields}); the row changes only after the commit lands.
 * - Every manifest sync applies what the file declares to the App rows
 *   ({@link syncDeclaredApps}), so a push wins without a deploy.
 *
 * A field the block does not declare stays the App's own. Everything else on
 * the row (name, access, external URL, runtime state) is not declarable.
 */
import { appLinks, apps, projects } from '@kortix/db';
import { validateAppsV2, type ManifestIssue } from '@kortix/manifest-schema';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { mutateManifestWithRetry, type ManifestCommitResult } from '../connectors/manifest-mutation';
import { withProjectGitAuth } from '../projects/surface';
import { db } from '../shared/db';

export interface AppManifestFields {
  cpu?: number;
  memory_gb?: number;
  disk_gb?: number;
  idle_timeout_seconds?: number;
  always_on?: boolean;
  labels?: string[];
  display?: Record<string, unknown>;
  uses?: string[];
}

const RESOURCE_KEYS = ['cpu', 'memory_gb', 'disk_gb'] as const;
const TOP_KEYS = ['idle_timeout_seconds', 'always_on', 'labels', 'display', 'uses'] as const;
type Row = Record<string, unknown>;
const isRow = (value: unknown): value is Row => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The fields of an App update that kortix.yaml can declare. */
export function manifestFieldsOf(input: Row): AppManifestFields {
  const out: Row = {};
  for (const key of [...RESOURCE_KEYS, ...TOP_KEYS]) if (input[key] !== undefined) out[key] = input[key];
  return out as AppManifestFields;
}

/** `block` with `fields` written in: size under `resources`, the rest at the top. Other keys stay. */
export function withAppFields(block: unknown, fields: AppManifestFields): Row {
  const out: Row = isRow(block) ? { ...block } : {};
  const resources: Row = isRow(out.resources) ? { ...out.resources } : {};
  let touchedResources = false;
  for (const key of RESOURCE_KEYS) {
    if (fields[key] !== undefined) { resources[key] = fields[key]; touchedResources = true; }
  }
  if (touchedResources) out.resources = resources;
  for (const key of TOP_KEYS) if (fields[key] !== undefined) out[key] = fields[key];
  return out;
}

/** What a block declares, in App-update terms. An undeclared field is absent. */
export function declaredAppFields(block: unknown): AppManifestFields {
  if (!isRow(block)) return {};
  const out: Row = {};
  if (isRow(block.resources)) for (const key of RESOURCE_KEYS) if (block.resources[key] !== undefined) out[key] = block.resources[key];
  for (const key of TOP_KEYS) if (block[key] !== undefined) out[key] = block[key];
  return out as AppManifestFields;
}

/**
 * Commit `fields` to `apps.<slug>` in the project's kortix.yaml (adding the
 * block when the App has none). Nothing is committed for an empty change.
 */
export async function commitAppFields(projectId: string, slug: string, fields: AppManifestFields): Promise<ManifestCommitResult> {
  if (Object.keys(fields).length === 0) return { ok: true };
  const [row] = await db.select().from(projects).where(eq(projects.projectId, projectId)).limit(1);
  if (!row) return { ok: false, error: 'project not found', status: 404 };
  let project: Awaited<ReturnType<typeof withProjectGitAuth>>;
  try {
    project = await withProjectGitAuth(row);
  } catch (error) {
    return { ok: false, error: (error as Error).message || 'failed to read kortix.yaml', status: 400 };
  }
  return mutateManifestWithRetry(project, `the App ${slug} was being updated`, (manifest) => {
    const appsNode: Row = isRow(manifest.raw.apps) ? { ...manifest.raw.apps } : {};
    const before = JSON.stringify(appsNode[slug] ?? null);
    appsNode[slug] = withAppFields(appsNode[slug], fields);
    if (JSON.stringify(appsNode[slug]) === before) return { ok: true, commitMessage: null };
    // A parent must name an App of the same file: an existing App with no block
    // gets an empty one (it declares nothing, so a sync leaves that App alone).
    const parent = fields.display?.parent;
    if (typeof parent === 'string' && !(parent in appsNode)) appsNode[parent] = {};
    const issues: ManifestIssue[] = [];
    validateAppsV2(appsNode, 'apps', issues);
    const error = issues.find((issue) => issue.severity === 'error' && issue.path.startsWith(`apps.${slug}`));
    if (error) return { ok: false, error: `${error.path} ${error.message}`, status: 400 };
    manifest.raw.apps = appsNode;
    return { ok: true, commitMessage: `chore: update App ${slug}` };
  });
}

/** `appsNode` without `slug`, and without every reference to it (`uses`, `display.parent`). */
export function withoutApp(appsNode: Row, slug: string): Row {
  const out: Row = {};
  for (const [name, block] of Object.entries(appsNode)) {
    if (name === slug) continue;
    if (!isRow(block)) { out[name] = block; continue; }
    const next: Row = { ...block };
    if (Array.isArray(next.uses)) next.uses = next.uses.filter((used) => used !== slug);
    if (isRow(next.display) && next.display.parent === slug) {
      const { parent: _parent, ...display } = next.display;
      next.display = display;
    }
    out[name] = next;
  }
  return out;
}

/** Remove `apps.<slug>` (and references to it) from kortix.yaml. Nothing is committed when the file does not declare it. */
export async function commitAppRemoval(projectId: string, slug: string): Promise<ManifestCommitResult> {
  const [row] = await db.select().from(projects).where(eq(projects.projectId, projectId)).limit(1);
  if (!row) return { ok: false, error: 'project not found', status: 404 };
  let project: Awaited<ReturnType<typeof withProjectGitAuth>>;
  try {
    project = await withProjectGitAuth(row);
  } catch (error) {
    return { ok: false, error: (error as Error).message || 'failed to read kortix.yaml', status: 400 };
  }
  return mutateManifestWithRetry(project, `the App ${slug} was being deleted`, (manifest) => {
    if (!isRow(manifest.raw.apps) || !(slug in manifest.raw.apps)) return { ok: true, commitMessage: null };
    manifest.raw.apps = withoutApp(manifest.raw.apps, slug);
    return { ok: true, commitMessage: `chore: remove App ${slug}` };
  });
}

/**
 * Apply what kortix.yaml declares to the project's App rows. An App the file
 * does not declare, and a field a block does not declare, stay as they are.
 * `uses` resolves by slug inside the project; an unknown slug is reported and
 * leaves the App's links unchanged.
 */
export async function syncDeclaredApps(projectId: string, appsNode: unknown): Promise<{ updated: string[]; errors: Array<{ slug: string; error: string }> }> {
  const result = { updated: [] as string[], errors: [] as Array<{ slug: string; error: string }> };
  if (!isRow(appsNode)) return result;
  const declared = Object.entries(appsNode).filter(([, block]) => Object.keys(declaredAppFields(block)).length > 0);
  if (declared.length === 0) return result;
  const rows = await db.select().from(apps)
    .where(and(eq(apps.projectId, projectId), inArray(apps.slug, declared.map(([slug]) => slug)), isNull(apps.deletedAt)));
  for (const [slug, block] of declared) {
    const row = rows.find((candidate) => candidate.slug === slug);
    if (!row) continue; // Declared, not created yet: the first deploy creates it.
    const fields = declaredAppFields(block);
    const update = {
      ...(fields.cpu !== undefined && fields.cpu !== row.cpuCores ? { cpuCores: fields.cpu } : {}),
      ...(fields.memory_gb !== undefined && fields.memory_gb !== row.memoryGb ? { memoryGb: fields.memory_gb } : {}),
      ...(fields.disk_gb !== undefined && fields.disk_gb !== row.diskGb ? { diskGb: fields.disk_gb } : {}),
      ...(fields.idle_timeout_seconds !== undefined && fields.idle_timeout_seconds !== row.idleTimeoutSeconds ? { idleTimeoutSeconds: fields.idle_timeout_seconds } : {}),
      ...(fields.always_on !== undefined && fields.always_on !== row.alwaysOn ? { alwaysOn: fields.always_on } : {}),
      ...(fields.labels !== undefined && JSON.stringify([...new Set(fields.labels)]) !== JSON.stringify(row.labels) ? { labels: [...new Set(fields.labels)] } : {}),
      ...(fields.display !== undefined && JSON.stringify(fields.display) !== JSON.stringify(row.display) ? { display: fields.display } : {}),
    };
    let links: Array<{ appId: string }> | null = null;
    if (fields.uses !== undefined) {
      const wanted = [...new Set(fields.uses)];
      const found = wanted.length
        ? await db.select({ appId: apps.appId, slug: apps.slug }).from(apps)
          .where(and(eq(apps.projectId, projectId), inArray(apps.slug, wanted), isNull(apps.deletedAt)))
        : [];
      const missing = wanted.filter((name) => name === slug || !found.some((candidate) => candidate.slug === name));
      if (missing.length) result.errors.push({ slug, error: `apps.${slug}.uses names no App of this project: ${missing.join(', ')}` });
      else {
        const current = await db.select({ usesAppId: appLinks.usesAppId }).from(appLinks).where(eq(appLinks.appId, row.appId));
        const same = current.length === found.length && found.every((candidate) => current.some((link) => link.usesAppId === candidate.appId));
        if (!same) links = found;
      }
    }
    if (Object.keys(update).length === 0 && !links) continue;
    await db.transaction(async (tx) => {
      if (links) {
        await tx.delete(appLinks).where(eq(appLinks.appId, row.appId));
        if (links.length) await tx.insert(appLinks).values(links.map((link) => ({ appId: row.appId, usesAppId: link.appId })));
      }
      if (Object.keys(update).length) await tx.update(apps).set({ ...update, updatedAt: new Date() }).where(eq(apps.appId, row.appId));
    });
    result.updated.push(slug);
  }
  return result;
}
