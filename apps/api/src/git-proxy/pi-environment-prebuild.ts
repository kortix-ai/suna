import { PI_WORKER_SANDBOX_SLUG } from '@kortix/shared';
import type { GitBackedProject } from '../projects/git/types';
import { resolveSessionSandboxSlug } from '../projects/lib/session-sandbox-metadata';

interface Dependencies {
  enabled(): boolean | Promise<boolean>;
  load(project: GitBackedProject): Promise<{
    projectDefault: string | null;
    agents: Array<{ enabled: boolean; sandbox?: string | null }>;
  }>;
  build(project: GitBackedProject, options: { slug: string; provider: 'daytona'; source: 'background' }): Promise<unknown>;
  failed(slug: string, error: unknown): void;
}

const defaults: Dependencies = {
  enabled: async () => (await import('../config')).config.isProviderEnabled('daytona'),
  load: async project => {
    const [{ readManifest }, { extractAgents }, { db }, { projects }, { eq }] = await Promise.all([
      import('../projects/triggers'), import('../projects/agents'), import('../shared/db'),
      import('@kortix/db'), import('drizzle-orm'),
    ]);
    const [manifest, rows] = await Promise.all([
      readManifest(project, { rethrowReadErrors: true }),
      db.select({ metadata: projects.metadata }).from(projects).where(eq(projects.projectId, project.projectId)).limit(1),
    ]);
    if (!manifest || manifest.schemaVersion !== 3) throw new Error('Pi environment prebuild requires a version 3 manifest');
    const loaded = extractAgents(manifest);
    if (loaded.errors.length) throw new Error('Pi environment prebuild requires valid agent declarations');
    const value = rows[0]?.metadata?.default_sandbox_slug;
    return { agents: loaded.specs, projectDefault: typeof value === 'string' ? value : null };
  },
  build: async (project, options) => (await import('../snapshots/builder')).ensureSandboxImage(project, options),
  failed: (slug, error) => console.warn(`[pi-environment-prebuild] ${slug} failed:`, error instanceof Error ? error.message : error),
};

export async function prebuildPiEnvironmentImages(
  project: GitBackedProject,
  sourceSha: string,
  dependencies: Dependencies = defaults,
): Promise<void> {
  if (!/^[a-f0-9]{40}$/.test(sourceSha)) throw new Error('Pi environment prebuild requires an exact commit');
  if (!await dependencies.enabled()) return;
  const pinned = { ...project, defaultBranch: sourceSha };
  const { agents, projectDefault } = await dependencies.load(pinned);
  const slugs = [...new Set(agents.filter(agent => agent.enabled).map(agent => {
    const slug = resolveSessionSandboxSlug({ agent: agent.sandbox, project: projectDefault });
    return slug === PI_WORKER_SANDBOX_SLUG ? resolveSessionSandboxSlug({}) : slug;
  }))];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(2, slugs.length) }, async () => {
    while (next < slugs.length) {
      const slug = slugs[next++]!;
      try {
        await dependencies.build(pinned, { slug, provider: 'daytona', source: 'background' });
      } catch (error) { dependencies.failed(slug, error); }
    }
  }));
}
