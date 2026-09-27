/** Project sandboxes and snapshots: status, health, rebuild, and fix-with-agent. */
import { PROJECT_ACTIONS } from '../../iam';
import { auth, errors, json } from '../../openapi';
import {
  deleteSandboxImage,
  kickPreBuild,
  listSandboxTemplates,
  listSnapshotBuilds,
  reconcileStaleBuilds,
  templateBuildProviders,
} from '../../snapshots/builder';
import { sessionTemplateBuilds } from '../../snapshots/build-state';
import { pickPrimaryTemplate, resolveSandboxRuntimeStatus } from '../../snapshots/sandbox-status';
import { classifySnapshotError, describeSnapshotError } from '../../snapshots/error-classify';
import { withTimeout } from '../../shared/with-timeout';
import { ttlMemo } from '../../shared/ttl-memo';
import { templateSlugFromBuildSlug } from '../../snapshots/build-slug';
import { TemplateNotFoundError } from '../../snapshots/templates';
import { createRoute, z } from '@hono/zod-openapi';
import { loadProjectForUser, assertProjectCapability } from '../lib/access';
import { AnyObject, SnapshotSchema, projectsApp } from '../lib/app';
import { loadGitProject } from '../lib/git';
import { allowStaleMirrorReads } from '../git/mirror';
import {
  normalizeString,
  requestAuditContext,
  serializeBuildSummary,
  serializeTemplate,
} from '../lib/serializers';
import { sendSessionCreateError } from '../lib/sessions';
import { createSession } from '../session-lifecycle';
import { rebuildFailureResponse, runProviderActions } from '../../snapshots/provider-actions';
import { templateProviderObservation } from '../lib/template-provider-observation';
import { readJsonObject } from '../../shared/http-body';

/**
 * Derive the ONE sandbox status every surface renders — sidebar alert, Customize
 * panel, and the fix-with-agent gate — so they can never disagree about whether
 * a project's sessions can start. See snapshots/sandbox-status.ts for why this
 * is derived from live provider coverage rather than from the build log.
 */
function projectSandboxStatus(args: {
  templates: Awaited<ReturnType<typeof listSandboxTemplates>>;
  builds: Awaited<ReturnType<typeof listSnapshotBuilds>>;
  metadata: unknown;
  selectedProvider: string | null;
}) {
  const meta = args.metadata && typeof args.metadata === 'object'
    ? args.metadata as Record<string, unknown>
    : null;
  const primary = pickPrimaryTemplate(args.templates, normalizeString(meta?.default_sandbox_slug));
  const templateBuilds = sessionTemplateBuilds(args.builds);
  // Only the primary template's own attempts describe the primary template.
  const primaryBuilds = primary
    ? templateBuilds.filter((build) => templateSlugFromBuildSlug(build.slug) === primary.slug)
    : templateBuilds;
  const status = resolveSandboxRuntimeStatus({
    snapshotName: primary?.snapshotName ?? null,
    coverage: primary?.providerCoverage ?? null,
    selectedProvider: args.selectedProvider,
    builds: primaryBuilds,
  });
  // A fix session must itself boot a sandbox, so it needs SOME image that works
  // — see the fix-with-agent handler, which enforces the same two conditions.
  const hasHostBuild = templateBuilds.some((build) => build.status === 'ready');
  return { primary, templateBuilds, status, hasHostBuild };
}

function serializeSandboxStatus(resolved: ReturnType<typeof projectSandboxStatus>) {
  const currentFailure = resolved.status.current_failure
    ? serializeBuildSummary(resolved.status.current_failure)
    : null;
  return {
    ...resolved.status,
    current_failure: currentFailure,
    stale_failure: resolved.status.stale_failure
      ? serializeBuildSummary(resolved.status.stale_failure)
      : null,
    /**
     * Whether POST /snapshots/fix-with-agent would accept right now. Derived
     * here from the same inputs the endpoint gates on so the button can never
     * offer an action the API answers 409 to — or hide one it would accept.
     */
    fix_with_agent_available:
      !!currentFailure && currentFailure.fixable_by_agent && resolved.hasHostBuild,
  };
}

// ─── Sandbox templates ─────────────────────────────────────────────────────
// One platform-default image, optionally extended by `sandbox: templates:` entries
// in kortix.yaml. Session boot is stateless: it computes the expected snapshot
// name from the resolved template, asks the selected provider if it is launch
// ready, and builds it there if not.
// The append-only `project_snapshot_builds` log feeds the UI but is never
// consulted by the boot path.


projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/sandboxes',
    tags: ['sandboxes'],
    summary: 'GET /:projectId/sandboxes',
    ...auth,
      request: {
        params: z.object({ projectId: z.string() }),
      },
    responses: {
        200: json(z.any(), 'OK'),
        ...errors(404, 500),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  const project = await loadGitProject(loaded);
  const observation = templateProviderObservation(loaded.row.metadata);
  try {
    const templates = await listSandboxTemplates(project, observation.listOptions);
    return c.json({
      items: templates.map((t) => serializeTemplate(t)),
      default_slug: templates.find((t) => t.isDefault)?.slug ?? templates[0]?.slug ?? null,
      provider_mode: observation.providerMode,
      selected_provider: observation.selectedProvider,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: `Failed to list sandbox templates: ${message}` }, 500);
  }
},
);

// GET /v1/projects/:projectId/snapshots
// Templates + recent build log. Used by the Sandbox panel.

/** Templates budget for `/snapshots`, under the web client's 30 s abort. */
const SNAPSHOTS_TEMPLATES_BUDGET_MS = 12_000;

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/snapshots',
    tags: ['sandboxes'],
    summary: 'GET /:projectId/snapshots',
    ...auth,
      request: {
        params: z.object({ projectId: z.string() }),
      },
    responses: {
        200: json(z.array(SnapshotSchema), 'Snapshots'),
        ...errors(404),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  // A page view: serve the warm git mirror, refresh it behind the response.
  allowStaleMirrorReads();
  const observation = templateProviderObservation(loaded.row.metadata);
  // Templates (git auth + repo reads + provider coverage) and the build log
  // (DB) are independent, so they run in parallel. Templates are bounded: a
  // cold git mirror clone can take minutes, and the Sandbox panel must answer
  // with the build log and a named error rather than spin to the client's 30 s
  // abort. The losing work settles in the background and warms the mirror.
  const templatesWork = loadGitProject(loaded).then((project) =>
    listSandboxTemplates(project, observation.listOptions),
  );
  // Heal any build rows orphaned at "building" by a process restart/crash
  // before reading them, so the dashboard never shows a permanent "Building".
  const buildsWork = reconcileStaleBuilds({ projectId })
    .catch(() => {})
    .then(() => listSnapshotBuilds(projectId, { limit: 25 }))
    .catch(() => []);
  let templates: Awaited<ReturnType<typeof listSandboxTemplates>> = [];
  let templatesError: string | null = null;
  try {
    templates = await withTimeout(templatesWork, SNAPSHOTS_TEMPLATES_BUDGET_MS, 'sandbox templates');
  } catch (err) {
    templatesError = err instanceof Error ? err.message : String(err);
  }
  const builds = await buildsWork;
  const resolved = projectSandboxStatus({
    templates,
    builds,
    metadata: loaded.row.metadata,
    selectedProvider: observation.selectedProvider,
  });
  return c.json({
    templates: templates.map((t) => serializeTemplate(t)),
    templates_error: templatesError,
    builds: builds.map(serializeBuildSummary),
    status: serializeSandboxStatus(resolved),
    provider_mode: observation.providerMode,
    selected_provider: observation.selectedProvider,
  });
},
);

// GET /v1/projects/:projectId/sandbox-health
// Cheap polling endpoint for the sidebar alert. Surfaces the platform default
// template's live state + the current failed build, if the newest attempt failed.
//
// Whole-handler wall-clock budget, kept comfortably under the frontend's 30s
// request timeout (apps/web/src/lib/api-client.ts → "Request timed out after
// 30s"). EVERY dependency this poll touches — git-auth resolution, the
// provider template lookups, AND the build-log DB query — can degrade
// independently, so bounding only the templates fetch still let a slow DB or
// git-auth call hang the request to the client's 30s abort. A single budget
// over the whole body guarantees the poll always answers fast: a degraded
// dependency renders the alert as "unknown / no templates" instead of paging
// us with the timeout error.
const SANDBOX_HEALTH_BUDGET_MS = 12_000;

interface SandboxHealthPayload {
  primary_slug: string | null;
  primary_template: ReturnType<typeof serializeTemplate> | null;
  ready: boolean;
  building: boolean;
  latest_build: ReturnType<typeof serializeBuildSummary> | null;
  latest_failure: ReturnType<typeof serializeBuildSummary> | null;
  /**
   * The derived answer to "can a session start, and if not, why". Every alert
   * must be driven by THIS, never by `latest_failure` — that field is the newest
   * failed row in the log whether or not it still describes anything bootable.
   */
  status: ReturnType<typeof serializeSandboxStatus> | null;
  provider_mode: 'automatic' | 'pinned';
  selected_provider: 'daytona' | 'platinum' | 'e2b' | null;
}

// Safe degraded payload: same shape as the happy path, surfaced when any
// dependency is too slow. "Unknown" rather than a hard error so the sidebar
// alert simply shows nothing and the next poll re-checks once we recover.
const SANDBOX_HEALTH_DEGRADED: SandboxHealthPayload = {
  primary_slug: null,
  primary_template: null,
  ready: false,
  building: false,
  latest_build: null,
  latest_failure: null,
  status: null,
  provider_mode: 'automatic',
  selected_provider: null,
};

async function buildSandboxHealth(
  loaded: NonNullable<Awaited<ReturnType<typeof loadProjectForUser>>>,
  projectId: string,
): Promise<SandboxHealthPayload> {
  const project = await loadGitProject(loaded);
  const observation = templateProviderObservation(loaded.row.metadata);
  let templates: Awaited<ReturnType<typeof listSandboxTemplates>> = [];
  try {
    // Repo unreachable / manifest broken / provider slow — render as "no
    // templates" rather than failing the whole poll. Each adapter owns its
    // provider-call timeout.
    templates = await listSandboxTemplates(project, observation.listOptions);
  } catch {
    /* no templates */
  }
  const builds = await listSnapshotBuilds(projectId, { limit: 10 }).catch(() => []);
  const resolved = projectSandboxStatus({
    templates,
    builds,
    metadata: loaded.row.metadata,
    selectedProvider: observation.selectedProvider,
  });
  const { primary, templateBuilds, status } = resolved;
  const latest = templateBuilds[0] ?? null;
  const latestFailure = templateBuilds.find((build) => build.status === 'failed') ?? null;

  return {
    primary_slug: primary?.slug ?? null,
    primary_template: primary ? serializeTemplate(primary) : null,
    ready: primary?.ready ?? false,
    building: status.state === 'building',
    latest_build: latest ? serializeBuildSummary(latest) : null,
    latest_failure: latestFailure ? serializeBuildSummary(latestFailure) : null,
    status: serializeSandboxStatus(resolved),
    provider_mode: observation.providerMode,
    selected_provider: observation.selectedProvider,
  };
}

/**
 * How long one project's sandbox-health answer is reused.
 *
 * `buildSandboxHealth` is not a database read: `listSandboxTemplates` calls
 * `provider.getSnapshotState()` — a LIVE round trip to Daytona / E2B / Platinum
 * — once per template, plus a git read to hash the template directory. On the
 * SampleCo corpus (2026-08-26) that made this "cheap polling endpoint" the
 * slowest non-proxy read on the box: 559 ms mean server-side over 169 calls,
 * 1 488 ms median as the browser saw it, and the whole cost is the provider
 * hop, not the query.
 *
 * The endpoint exists to drive a sidebar alert that the client re-polls anyway,
 * so an answer up to this old is indistinguishable to a user — a snapshot that
 * finishes building shows up on the next poll instead of this one. In-flight
 * calls share one promise, so N concurrent polls (six per session open in the
 * corpus) collapse to one provider round trip rather than N.
 *
 * Keyed by project because the template set, its content hash and the provider
 * pin are all per-project.
 */
const SANDBOX_HEALTH_TTL_MS = 10_000;

const sandboxHealthMemo = ttlMemo({
  ttlMs: SANDBOX_HEALTH_TTL_MS,
  keyFn: (_loaded: NonNullable<Awaited<ReturnType<typeof loadProjectForUser>>>, projectId: string) =>
    projectId,
  loader: (loaded, projectId) => buildSandboxHealth(loaded, projectId),
});

/**
 * Drop a project's cached health answer. Called by the writes that change it
 * (rebuild / provider pin) so the UI reflects them on the very next poll
 * instead of waiting out the TTL.
 */
export function invalidateSandboxHealth(projectId: string): void {
  sandboxHealthMemo.invalidate(projectId);
}

// Exported for unit coverage of the wall-clock degradation contract.
export { SANDBOX_HEALTH_BUDGET_MS, SANDBOX_HEALTH_DEGRADED, SANDBOX_HEALTH_TTL_MS, buildSandboxHealth };

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/sandbox-health',
    tags: ['sandboxes'],
    summary: 'GET /:projectId/sandbox-health',
    ...auth,
      request: {
        params: z.object({ projectId: z.string() }),
      },
    responses: {
        200: json(z.any(), 'OK'),
        ...errors(404),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  let payload: SandboxHealthPayload = SANDBOX_HEALTH_DEGRADED;
  try {
    payload = await withTimeout(
      sandboxHealthMemo(loaded, projectId),
      SANDBOX_HEALTH_BUDGET_MS,
      'sandbox-health',
    );
  } catch {
    // Any dependency (git-auth / templates / build-log DB) too slow or
    // failing — degrade to "unknown" rather than hang to the client's 30s
    // abort. The losing work settles in the background; the next poll retries.
  }

  return c.json(payload);
},
);

// POST /v1/projects/:projectId/snapshots/rebuild
// Force-rebuild the image for a given template slug (defaults to the platform
// default). Deletes the existing image on every enabled provider so the routed
// rebuilds all start from the same current definition. Returns 202.

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/snapshots/rebuild',
    tags: ['sandboxes'],
    summary: 'POST /:projectId/snapshots/rebuild',
    ...auth,
      request: {
        params: z.object({ projectId: z.string() }),
        body: { content: { 'application/json': { schema: AnyObject } } },
      },
    responses: {
        202: json(z.any(), 'OK'),
        ...errors(404, 409, 502, 503),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  // Capability gate: rebuilding snapshots/templates re-provisions infra. Gated on
  // project.customize.write so a custom role can withhold it (humans) AND the
  // agent-grant fold applies (agent sessions). Managers hold it by default.
  await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_CUSTOMIZE_WRITE);

  const body = await readJsonObject(c);
  const slugRaw = (typeof body.slug === 'string' && body.slug)
    || (typeof body.sandbox_slug === 'string' && body.sandbox_slug)
    || undefined;
  const slug = slugRaw ? String(slugRaw).trim() : undefined;

  const project = await loadGitProject(loaded);
  const providers = templateBuildProviders();
  if (providers.length === 0) {
    return c.json({ error: 'No sandbox template provider is enabled' }, 503);
  }
  // The poll answer is cached for SANDBOX_HEALTH_TTL_MS; a deliberate rebuild
  // must show up on the very next poll, not up to a TTL later.
  invalidateSandboxHealth(projectId);
  try {
    const attempts = await runProviderActions(
      providers,
      async (provider) => {
        const deleted = await deleteSandboxImage(project, { slug, provider });
        kickPreBuild(project, {
          slug: deleted.slug,
          accountId: loaded.row.accountId,
          source: 'manual',
          provider,
        });
        return deleted;
      },
    );
    const notFound = attempts.failed.find(
      (failure) => failure.error instanceof TemplateNotFoundError,
    );
    if (notFound?.error instanceof TemplateNotFoundError) {
      return c.json({ error: notFound.error.message, code: 'TEMPLATE_NOT_FOUND' }, 404);
    }
    for (const failure of attempts.failed) {
      console.warn(
        `[snapshots/rebuild] project=${projectId} provider=${failure.provider} failed:`,
        failure.error instanceof Error ? failure.error.message : String(failure.error),
      );
    }
    if (attempts.started.length === 0) {
      const failure = rebuildFailureResponse(attempts.failed);
      return c.json(failure.body, failure.status);
    }
    const target = attempts.started[0]!.result;
    return c.json(
      {
        status: 'started',
        slug: target.slug,
        deleted_existing: attempts.started.some((item) => item.result.deleted),
        snapshot_name: target.snapshotName,
        providers: attempts.started.map((item) => item.provider),
        failed_providers: attempts.failed.map((item) => item.provider),
      },
      202,
    );
  } catch (err) {
    // A slug that names no template is the caller's mistake, not a provider
    // outage — folding it into 502 hid the real bug (a build slug like
    // `default-warm` being sent where a template slug was required) behind a
    // status that reads as "Daytona is down".
    if (err instanceof TemplateNotFoundError) {
      return c.json({ error: err.message, code: 'TEMPLATE_NOT_FOUND' }, 404);
    }
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 502);
  }
},
);

// POST /v1/projects/:projectId/snapshots/fix-with-agent
// Spin up a session pre-seeded with the most recent build failure so an agent
// can diagnose + fix the Dockerfile and open a change request. Requires a
// previous successful build to host the fix session.

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/snapshots/fix-with-agent',
    tags: ['sandboxes'],
    summary: 'POST /:projectId/snapshots/fix-with-agent',
    ...auth,
      request: {
        params: z.object({ projectId: z.string() }),
      },
    responses: {
        201: json(z.any(), 'OK'),
        ...errors(404, 409),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  // Capability gate: rebuilding snapshots/templates re-provisions infra. Gated on
  // project.customize.write so a custom role can withhold it (humans) AND the
  // agent-grant fold applies (agent sessions). Managers hold it by default.
  await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_CUSTOMIZE_WRITE);
  const userId = c.get('userId') as string;

  const builds = await listSnapshotBuilds(projectId, { limit: 50 }).catch(() => []);
  // Gate on the SAME derived status the UI renders, not on the newest failed row:
  // a build that failed against a definition nobody boots anymore — or whose image
  // the provider has since brought up — has nothing left for an agent to fix, and
  // sending one after it burns a session on a phantom.
  const observation = templateProviderObservation(loaded.row.metadata);
  let templates: Awaited<ReturnType<typeof listSandboxTemplates>> = [];
  let templatesUnavailable = false;
  try {
    // Repo unreachable / manifest broken / provider slow. Without the current
    // template identity we cannot tell a live failure from a stale one, and
    // guessing in either direction is worse than saying so.
    templates = await listSandboxTemplates(await loadGitProject(loaded), observation.listOptions);
  } catch {
    templatesUnavailable = true;
  }
  const { templateBuilds, status } = projectSandboxStatus({
    templates,
    builds,
    metadata: loaded.row.metadata,
    selectedProvider: observation.selectedProvider,
  });
  const failed = status.current_failure;
  if (!failed) {
    if (templatesUnavailable) {
      return c.json(
        {
          error:
            'Could not read this project’s sandbox templates, so the current build state is unknown. Try again in a moment.',
          code: 'SANDBOX_STATE_UNKNOWN',
        },
        409,
      );
    }
    return c.json(
      {
        error: status.stale_failure
          ? 'That build failure no longer applies — the current sandbox image is not failing.'
          : 'No current failed snapshot build to fix.',
        code: 'NO_CURRENT_FAILURE',
      },
      409,
    );
  }

  const errorText = failed.error ?? 'Snapshot build failed';
  const category = failed.errorCategory ?? classifySnapshotError(errorText);
  const info = describeSnapshotError(category as ReturnType<typeof classifySnapshotError>);

  // Infra failures (quota, provider blip, timeout) are not repo-editable. Spinning up
  // a fix session for one is worse than useless: the session must boot a sandbox from
  // a snapshot, which is exactly what the failure prevented — so it fails to start the
  // very session meant to diagnose it. Refuse loudly rather than 400 from deep inside
  // session creation.
  if (!info.fixableByAgent) {
    return c.json(
      {
        error: `${info.title}: ${info.hint}`,
        code: 'NOT_AGENT_FIXABLE',
        category,
      },
      409,
    );
  }

  const hostBuild = templateBuilds.find((b) => b.status === 'ready');
  if (!hostBuild) {
    return c.json(
      {
        error:
          'No ready sandbox to run the fix in yet. Retry the build, or edit the Dockerfile manually.',
        code: 'NO_READY_SANDBOX',
      },
      409,
    );
  }

  const prompt = [
    `The sandbox image build for the "${failed.slug}" template is failing, so new sessions on it can't boot. Diagnose and fix the root cause, then open a change request.`,
    ``,
    `Failing template: ${failed.slug}`,
    `Error type: ${category} — ${info.title}`,
    info.hint,
    ``,
    `Build error:`,
    '```',
    errorText.slice(0, 4000),
    '```',
    ``,
    `The sandbox image is built from the template definition (see sandbox.templates in kortix.yaml).`,
    ``,
    `Steps:`,
    `1. Inspect the relevant Dockerfile and the build error above.`,
    `2. Fix the root cause.`,
    `3. Open a change request. Once it merges, the image rebuilds automatically.`,
  ].join('\n');

  const result = await createSession({
    source: 'system:sandbox-build-fix',
    project: loaded.row,
    userId,
    requestingPrincipalType:
      c.get('authType') === 'service_account' ? 'service_account' : 'human',
    // Platform-maintenance session — stamp the system source at the TOP-LEVEL
    // metadata (the trusted, server-set channel resolveSessionOrigin reads), so
    // its origin resolves to 'system' (source wins first). Under body.metadata
    // it would persist but NOT drive the origin, since derivation never trusts
    // the request body.
    metadata: { source: 'system:sandbox-build-fix' },
    body: {
      initial_prompt: prompt,
      name: 'Fix sandbox build',
      metadata: {
        kind: 'sandbox-build-fix',
        failed_slug: failed.slug,
      },
      // hostBuild.slug is a BUILD slug — for a warm bake it reads `default-warm`,
      // which names no template, so session creation rejected it with a 400.
      sandbox_slug: templateSlugFromBuildSlug(hostBuild.slug),
    },
    request: requestAuditContext(c),
    queuePolicy: 'never',
  });
  if (result.error) return sendSessionCreateError(c, result.error);
  if (!result.row) return c.json({ error: 'Session creation returned no row' }, 500);

  return c.json({ session_id: result.row.sessionId }, 201);
},
);
