import { errors } from '../../openapi';
import { db } from '../../shared/db';
import { getLatestDeployment } from '../app-sweep';
import { appSpecToTomlEntry, loadProjectApps, manifestHashForApp, resolveAppDomains, type AppBuildSpec, type AppSourceSpec, type AppSpec } from '../apps';
import { resolveAppsEnabled } from '../apps-config';
import { MANIFEST_FILENAME, type ParsedManifest } from '../triggers';
import { projects } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { withProjectGitAuth } from './git';
import { ProjectRow, normalizeBoolean, normalizeString, serializeDeploymentRow } from './serializers';
import { slugify } from './triggers';

export interface SlackAuthTest {
  ok: boolean;
  team_id?: string;
  team?: string;
  user_id?: string;
  error?: string;
}

// GET /v1/projects/:projectId/channels/slack/installation

export const APPS_DISABLED_BODY = {
  error: 'kortix [[apps]] is experimental and disabled for this project. Enable it in Customize → Settings (or set KORTIX_APPS_EXPERIMENTAL=true to default it on).',
} as const;


export async function projectAppsEnabled(projectId: string): Promise<boolean> {
  const [row] = await db
    .select({ metadata: projects.metadata })
    .from(projects)
    .where(eq(projects.projectId, projectId))
    .limit(1);
  return resolveAppsEnabled(row?.metadata);
}


export interface AppDraft {
  slug: string;
  name: string;
  enabled: boolean;
  domains: string[];
  framework: string | null;
  source: AppSourceSpec;
  build: AppBuildSpec | null;
  env: Record<string, string>;
}


export function parseAppDraft(
  body: Record<string, unknown>,
  opts: { existingSlug: string | null },
): AppDraft | { error: string } {
  const rawSlug = normalizeString((body as any).slug);
  const name = normalizeString((body as any).name) ?? rawSlug ?? opts.existingSlug ?? null;
  if (!name) return { error: 'name (or slug) is required' };

  const slug = opts.existingSlug ?? rawSlug ?? slugify(name);
  if (!/^[a-z0-9][a-z0-9_-]{0,127}$/.test(slug)) {
    return { error: `Invalid slug "${slug}" — use letters, digits, dashes, underscores only` };
  }

  const enabled = normalizeBoolean((body as any).enabled) ?? true;

  // Domains are optional — omit them and the platform auto-issues a free
  // `*.style.dev` URL at deploy time (see defaultAppDomain). When present,
  // each entry must be a non-empty string.
  const domainsRaw = (body as any).domains;
  const domains: string[] = [];
  if (domainsRaw !== undefined && domainsRaw !== null) {
    if (!Array.isArray(domainsRaw)) {
      return { error: 'domains must be an array of strings when set' };
    }
    for (const d of domainsRaw) {
      const s = normalizeString(d);
      if (!s) return { error: 'domains entries must be non-empty strings' };
      domains.push(s);
    }
  }

  const framework = normalizeString((body as any).framework);

  const sourceBody = (body as any).source ?? {};
  if (typeof sourceBody !== 'object' || sourceBody === null || Array.isArray(sourceBody)) {
    return { error: 'source must be an object' };
  }
  const sourceType = normalizeString(sourceBody.type)?.toLowerCase();
  let source: AppSourceSpec;
  if (sourceType === 'git') {
    source = {
      type: 'git',
      repo: normalizeString(sourceBody.repo),
      branch: normalizeString(sourceBody.branch),
      rootPath: normalizeString(sourceBody.root_path ?? sourceBody.rootPath),
    };
  } else if (sourceType === 'tar') {
    const url = normalizeString(sourceBody.url);
    if (!url) return { error: 'source type="tar" requires a non-empty url' };
    source = { type: 'tar', url };
  } else {
    return { error: `source.type must be "git" or "tar" (got "${sourceType ?? 'unset'}")` };
  }

  let build: AppBuildSpec | null = null;
  const buildBody = (body as any).build;
  if (buildBody && typeof buildBody === 'object' && !Array.isArray(buildBody)) {
    const command = normalizeString(buildBody.command);
    const outDir = normalizeString(buildBody.out_dir ?? buildBody.outDir);
    if (command || outDir) build = { command, outDir };
  }

  const envBody = (body as any).env;
  const env: Record<string, string> = {};
  if (envBody && typeof envBody === 'object' && !Array.isArray(envBody)) {
    for (const [k, v] of Object.entries(envBody as Record<string, unknown>)) {
      if (typeof v !== 'string') return { error: `env.${k} must be a string` };
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) return { error: `env key "${k}" must look like an env var name` };
      env[k] = v;
    }
  }

  return { slug, name, enabled, domains, framework, source, build, env };
}


export function draftToAppSpec(draft: AppDraft): AppSpec {
  return {
    slug: draft.slug,
    path: `${MANIFEST_FILENAME}#apps.${draft.slug}`,
    name: draft.name,
    enabled: draft.enabled,
    source: draft.source,
    build: draft.build,
    env: draft.env,
    domains: draft.domains,
    framework: draft.framework,
  };
}


export function upsertAppInManifest(manifest: ParsedManifest, spec: AppSpec): ParsedManifest {
  const current = Array.isArray(manifest.raw.apps)
    ? (manifest.raw.apps as Record<string, unknown>[])
    : [];
  const idx = current.findIndex((entry) => typeof entry?.slug === 'string' && entry.slug === spec.slug);
  const entry = appSpecToTomlEntry(spec);
  const next = current.slice();
  if (idx >= 0) next[idx] = entry;
  else next.push(entry);
  return { ...manifest, raw: { ...manifest.raw, apps: next } };
}


export function removeAppFromManifest(manifest: ParsedManifest, slug: string): ParsedManifest {
  const current = Array.isArray(manifest.raw.apps)
    ? (manifest.raw.apps as Record<string, unknown>[])
    : [];
  const next = current.filter((entry) => !(typeof entry?.slug === 'string' && entry.slug === slug));
  return { ...manifest, raw: { ...manifest.raw, apps: next } };
}


export function specToAppBody(spec: AppSpec): Record<string, unknown> {
  return {
    slug: spec.slug,
    name: spec.name,
    enabled: spec.enabled,
    domains: spec.domains,
    framework: spec.framework,
    source:
      spec.source.type === 'git'
        ? {
            type: 'git',
            repo: spec.source.repo,
            branch: spec.source.branch,
            root_path: spec.source.rootPath,
          }
        : { type: 'tar', url: spec.source.url },
    build: spec.build
      ? { command: spec.build.command, out_dir: spec.build.outDir }
      : null,
    env: spec.env,
  };
}


export async function loadAppsForResponse(projectId: string, project: ProjectRow) {
  const { specs, errors } = await loadProjectApps(await withProjectGitAuth(project));
  const apps = await Promise.all(
    specs.map(async (spec) => {
      const latest = await getLatestDeployment(projectId, spec.slug);
      const desiredHash = manifestHashForApp(spec);
      const currentHash = (latest?.metadata as Record<string, unknown> | null)?.manifest_hash;
      return {
        ...specToAppBody(spec),
        path: spec.path,
        manifest_hash: desiredHash,
        // The domains the app will actually serve on — its declared domains,
        // or the auto-issued free *.style.dev URL when it declared none. Lets
        // the UI show the target address before the first deploy.
        effective_domains: resolveAppDomains(projectId, spec),
        latest_deployment: latest ? serializeDeploymentRow(latest) : null,
        drift: latest ? currentHash !== desiredHash : true,
      };
    }),
  );
  return { apps, errors };
}

// GET /v1/projects/:projectId/apps — list specs + latest deployment status
