import { templateSlugFromBuildSlug } from './build-slug';
import type { listSandboxTemplates, listSnapshotBuilds } from './builder';
import {
  type SnapshotErrorCategory,
  classifySnapshotError,
  describeSnapshotError,
} from './error-classify';

export function serializeBuildSummary(b: Awaited<ReturnType<typeof listSnapshotBuilds>>[number]) {
  // errorCategory is a free-form column; older rows predate the classifier.
  const category = (b.errorCategory ??
    (b.error ? classifySnapshotError(b.error) : null)) as SnapshotErrorCategory | null;
  return {
    build_id: b.buildId,
    slug: b.slug,
    /**
     * The TEMPLATE this build was for. `slug` may be a build-log pseudo-slug
     * (`default-warm`) that names no template; clients that want to act on a build
     * — rebuild it, boot a session on it — must use this, never `slug`.
     */
    template_slug: templateSlugFromBuildSlug(b.slug),
    snapshot_name: b.snapshotName,
    content_hash: b.contentHash,
    status: b.status,
    error: b.error,
    error_category: category,
    /**
     * Whether an in-sandbox agent could plausibly fix this by editing the repo.
     * Server-derived so the UI can't drift from what the API will accept: infra
     * failures (quota, provider, timeout) are not repo-editable, and a fix session
     * can't even boot when the snapshot it needs is the thing that failed.
     */
    fixable_by_agent: category ? describeSnapshotError(category).fixableByAgent : false,
    source: b.source,
    provider: b.provider,
    started_at: b.startedAt.toISOString(),
    finished_at: b.finishedAt?.toISOString() ?? null,
  };
}

export function serializeTemplate(t: Awaited<ReturnType<typeof listSandboxTemplates>>[number]) {
  return {
    template_id: t.templateId,
    slug: t.slug,
    name: t.name,
    is_default: t.isDefault,
    source: t.source,
    provider: t.provider,
    has_dockerfile: t.hasDockerfile,
    has_image: t.hasImage,
    image: t.image,
    dockerfile_path: t.dockerfilePath,
    entrypoint: t.entrypoint,
    cpu: t.cpu,
    memory_gb: t.memoryGb,
    disk_gb: t.diskGb,
    snapshot_name: t.snapshotName,
    content_hash: t.contentHash,
    built_from_commit: t.builtFromCommit,
    daytona_state: t.daytonaState,
    provider_state: t.providerState,
    ready: t.ready,
    ...(t.providerCoverage ? { provider_coverage: t.providerCoverage } : {}),
  };
}
