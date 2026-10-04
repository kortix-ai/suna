import { type GitBackedProject } from '../services/git';
import { getSandboxProvider } from './providers';
import { config, type SandboxProviderName } from '../lib/config';
import { computeTemplateIdentity, listTemplatesForProject, resolveTemplateForBuildSlug, refreshTemplateState, type ResolvedTemplate } from './templates';
import { enabledTemplateBuildProviders, observeTemplateProviderCoverage, resolveRoutedTemplateState, type SandboxTemplateProvider, type SandboxTemplateProviderCoverage } from './provider-coverage';
import { ensureSandboxImage, type SnapshotBuildSource } from './builder';
import { shouldReconcileProviderState } from './builder-log';

/**
 * Fire-and-forget pre-build. Used at project-create and CR-merge time so the
 * first session for a new commit can boot off a cache hit.
 */
export function kickPreBuild(
  project: GitBackedProject,
  opts: { slug?: string; accountId: string; source: SnapshotBuildSource; provider?: string },
): void {
  void ensureSandboxImage(project, opts).catch((err) =>
    console.warn(
      `[snapshots] pre-build failed for ${project.projectId} (slug=${opts.slug ?? 'default'}, ${opts.source}):`,
      err instanceof Error ? err.message : err,
    ),
  );
}

/** Providers a project can route a new session to for proactive template builds. */
export function templateBuildProviders(): SandboxTemplateProvider[] {
  return enabledTemplateBuildProviders({
    allowed: config.ALLOWED_SANDBOX_PROVIDERS,
    isEnabled: (provider) => config.isProviderEnabled(provider as SandboxProviderName),
  });
}

/** Fire the same content-addressed build independently on every routed provider. */
export function kickRoutedPreBuild(
  project: GitBackedProject,
  opts: {
    slug?: string;
    accountId: string;
    source: SnapshotBuildSource;
  },
): void {
  for (const provider of templateBuildProviders()) {
    kickPreBuild(project, {
      slug: opts.slug,
      accountId: opts.accountId,
      source: opts.source,
      provider,
    });
  }
}
// ─── Custom (toml / UI) templates — explicit rebuilds ────────────────────────

/**
 * Reconcile a project's OWN templates (never the shared default): for each
 * custom template whose built image is stale or missing relative to its
 * currently-computed identity, kick a pre-build. Driven by project-create and
 * CR-merge so a Dockerfile or spec change lands a fresh image proactively
 * instead of stalling the next session that boots the slug. Forces a TOML sync
 * so a `[[sandbox.templates]]` edit in the just-merged commit is picked up.
 */
async function reconcileProjectTemplates(
  project: GitBackedProject,
  opts: { accountId: string; source: SnapshotBuildSource },
): Promise<{ checked: number; rebuilt: number }> {
  const templates = await listTemplatesForProject(project, { forceTomlSync: true });
  const providers = templateBuildProviders();
  let rebuilt = 0;
  for (const t of templates) {
    if (t.isShared) continue; // the platform default is built globally
    let identity: Awaited<ReturnType<typeof computeTemplateIdentity>>;
    try {
      identity = await computeTemplateIdentity(project, t);
    } catch (err) {
      console.warn(
        `[snapshots] reconcile: cannot compute identity for ${project.projectId}/${t.slug}:`,
        err instanceof Error ? err.message : err,
      );
      continue;
    }
    for (const providerId of providers) {
      const provider = getSandboxProvider(providerId);
      const state = await provider.getSnapshotState(identity.snapshotName);
      if (state === 'active') continue;
      if (!shouldReconcileProviderState(state)) continue;
      kickPreBuild(project, {
        slug: t.slug,
        accountId: opts.accountId,
        source: opts.source,
        provider: providerId,
      });
      rebuilt += 1;
    }
  }
  return { checked: templates.length, rebuilt };
}

/** Fire-and-forget wrapper around {@link reconcileProjectTemplates}. */
export function kickProjectTemplatePrebuilds(
  project: GitBackedProject,
  opts: { accountId: string; source: SnapshotBuildSource },
): void {
  void reconcileProjectTemplates(project, opts).catch((err) =>
    console.warn(
      `[snapshots] project-template reconcile failed for ${project.projectId} (${opts.source}):`,
      err instanceof Error ? err.message : err,
    ),
  );
}

/**
 * Force the next session to rebuild by deleting the provider-side snapshot
 * for a given slug. No-op if nothing is there.
 *
 * Accepts a BUILD slug (`default-warm`) as well as a template slug: the retry
 * surfaces hand us whatever `latest_failure.slug` held, and the warm bake's build
 * row is never a template. Deleting the base template's snapshot is the correct
 * response either way — the warm image is re-baked from it.
 */
export async function deleteSandboxImage(
  project: GitBackedProject,
  opts: { slug?: string; provider?: string } = {},
): Promise<{ deleted: boolean; snapshotName: string; slug: string }> {
  const template = await resolveTemplateForBuildSlug(project, opts.slug);
  const provider = getSandboxProvider(opts.provider ?? template.provider);
  const identity = await computeTemplateIdentity(project, template);
  const before = await provider.getSnapshotState(identity.snapshotName);
  await provider.deleteSnapshot(identity.snapshotName);
  // Reflect on the template row.
  if (template.templateId) {
    try {
      await refreshTemplateState(template.templateId);
    } catch {
      /* best-effort */
    }
  }
  return {
    deleted: before === 'active' || before === 'building',
    snapshotName: identity.snapshotName,
    slug: template.slug,
  };
}

type TemplateIdentity = Awaited<ReturnType<typeof computeTemplateIdentity>>;

/** Stateless view of every template available to the project + live state. */
export interface SandboxTemplateView {
  templateId: string | null;
  slug: string;
  name: string;
  isDefault: boolean;
  source: 'platform' | 'toml' | 'ui';
  hasDockerfile: boolean;
  hasImage: boolean;
  image: string | null;
  dockerfilePath: string | null;
  entrypoint: string | null;
  cpu: number;
  memoryGb: number;
  diskGb: number;
  snapshotName: string;
  contentHash: string;
  daytonaState: string;
  providerState: string;
  ready: boolean;
  provider: string;
  builtFromCommit: string | null;
  lastBuiltAt: string | null;
  lastError: string | null;
  /** Fresh launch-readiness observations for this exact content identity. */
  providerCoverage?: SandboxTemplateProviderCoverage[];
}

export async function listSandboxTemplates(
  project: GitBackedProject,
  opts: {
    /** Explicit project pin. null means Automatic routing across enabled providers. */
    selectedProvider?: SandboxTemplateProvider | null;
    includeProviderCoverage?: boolean;
  } = {},
): Promise<SandboxTemplateView[]> {
  const items = await listTemplatesForProject(project);
  const results = await Promise.allSettled(items.map((t) => toView(project, t, opts)));
  const views: SandboxTemplateView[] = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === 'fulfilled') {
      views.push(r.value);
    } else {
      const reason = r.reason instanceof Error ? r.reason.message : String(r.reason);
      console.warn(`[sandbox-templates] skipping template "${items[i]!.slug}": ${reason}`);
    }
  }
  return views;
}

async function toView(
  project: GitBackedProject,
  t: ResolvedTemplate,
  opts: {
    selectedProvider?: SandboxTemplateProvider | null;
    includeProviderCoverage?: boolean;
  },
): Promise<SandboxTemplateView> {
  const identity = await computeTemplateIdentity(project, t);
  let state: string = t.providerState ?? 'missing';
  let providerCoverage: SandboxTemplateProviderCoverage[] | undefined;
  if (opts.includeProviderCoverage) {
    providerCoverage = await observeTemplateProviderCoverage(identity.snapshotName, {
      isProviderEnabled: (provider) => config.isProviderEnabled(provider),
      getProvider: (provider) => getSandboxProvider(provider),
      now: () => new Date(),
    });
    state = resolveRoutedTemplateState(providerCoverage, opts.selectedProvider ?? null);
  } else {
    try {
      const provider = getSandboxProvider(t.provider);
      if (provider.isConfigured()) {
        state = await provider.getSnapshotState(identity.snapshotName);
      }
    } catch {
      /* keep cached */
    }
  }
  return {
    templateId: t.templateId,
    slug: t.slug,
    name: t.name,
    isDefault: t.isShared,
    source: t.source,
    hasDockerfile: !!t.dockerfilePath,
    hasImage: !!t.image,
    image: t.image,
    dockerfilePath: t.dockerfilePath,
    entrypoint: t.entrypoint,
    cpu: t.cpu,
    memoryGb: t.memoryGb,
    diskGb: t.diskGb,
    snapshotName: identity.snapshotName,
    contentHash: identity.contentHash,
    daytonaState: state,
    providerState: state,
    ready: state === 'active',
    provider: t.provider,
    builtFromCommit: t.builtFromCommit,
    lastBuiltAt: null,
    lastError: null,
    ...(providerCoverage ? { providerCoverage } : {}),
  };
}
