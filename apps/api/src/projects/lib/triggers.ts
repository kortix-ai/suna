import { config } from '../../config';
import { auth, errors } from '../../openapi';
import { maxConcurrentSessionsForTier, resolveAccountTier } from '../../shared/account-limits';
import { db } from '../../shared/db';
import { runProjectAppSweep } from '../app-sweep';
import { commitFileToBranch, invalidateProjectMirror } from '../git';
import { commitFile, getFileSha, type GitHubAuthContext } from '../github';
import { KNOWN_SCHEMA_VERSION, MANIFEST_FILENAME, loadProjectTriggers, readManifest, serializeManifest, triggerSpecToTomlEntry, type GitTriggerSpec, type ParsedManifest } from '../triggers';
import { accountMembers, projectTriggerRuntime, projects } from '@kortix/db';
import { Cron } from 'croner';
import { and, eq } from 'drizzle-orm';
import { Context } from 'hono';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { parseGitHubRepoUrl, resolveProjectGitAuth, withProjectGitAuth } from './git';
import { ProjectRow, RequestAuditContext, deriveKortixApiRoot, isPlainObject, normalizeBoolean, normalizeString } from './serializers';
import { countActiveProjectSessions, countProvisioningProjectSessions, createProjectSession } from './sessions';

export function normalizeSignatureHeader(value: string | null): string | null {
  const header = normalizeString(value);
  if (!header) return null;
  return header.startsWith('sha256=') ? header.slice('sha256='.length) : header;
}


export function verifyWebhookSignature(rawBody: string, secret: string, signatureHeader: string | null) {
  const signature = normalizeSignatureHeader(signatureHeader);
  if (!signature || !/^[a-f0-9]{64}$/i.test(signature)) return false;

  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const actualBuffer = Buffer.from(signature, 'hex');
  const expectedBuffer = Buffer.from(expected, 'hex');
  if (actualBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(actualBuffer, expectedBuffer);
}


export function parseWebhookJsonBody(rawBody: string): unknown {
  if (!rawBody.trim()) return {};
  try {
    return JSON.parse(rawBody);
  } catch {
    return { raw: rawBody };
  }
}


export function valueAtPath(source: unknown, path: string[]): unknown {
  let current = source;
  for (const segment of path) {
    if (!isPlainObject(current)) return undefined;
    current = current[segment];
  }
  return current;
}


export function templateValue(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}


export function renderPromptTemplate(template: string, payload: Record<string, unknown>) {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_match, token: string) => {
    const [root, ...path] = token.split('.');
    if (!root) return '';
    const value = path.length === 0 ? payload[root] : valueAtPath(payload[root], path);
    return templateValue(value);
  });
}


export function webhookPayload(c: Context, rawBody: string) {
  const body = parseWebhookJsonBody(rawBody);
  return {
    body,
    headers: {
      content_type: c.req.header('content-type') ?? null,
      user_agent: c.req.header('user-agent') ?? null,
      forwarded_for: c.req.header('x-forwarded-for') ?? null,
    },
  };
}


export function triggerBackpressureLimit() {
  const configured = Number((config as any).KORTIX_TRIGGER_MAX_PROVISIONING_SESSIONS_PER_PROJECT);
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 3;
}


export async function triggerBackpressureState(accountId: string, projectId: string) {
  const [provisioning, active, tier] = await Promise.all([
    countProvisioningProjectSessions(projectId),
    countActiveProjectSessions(accountId),
    resolveAccountTier(accountId),
  ]);
  const projectProvisioningLimit = triggerBackpressureLimit();
  const accountActiveLimit = maxConcurrentSessionsForTier(tier);
  return {
    shouldQueue: provisioning >= projectProvisioningLimit || active >= accountActiveLimit,
    provisioning,
    projectProvisioningLimit,
    active,
    accountActiveLimit,
    tier,
  };
}

// POST /v1/webhooks/projects/:projectId/:slug
//
// Public fire endpoint for GIT-BACKED webhook triggers. The trigger config
// lives in `.opencode/triggers/<slug>.md` in the project repo; the signing
// secret lives in `project_secrets` (referenced from the file via
// `secret_env`). On a valid signed POST, we render the prompt template and
// spawn a session — same as the DB-backed `/v1/webhooks/:triggerId` path,
// but the source of truth is git.

export type TriggerSchedulerTimer = ReturnType<typeof setInterval>;


export const globalForProjectTriggers = globalThis as typeof globalThis & {
  __kortixProjectTriggerSchedulerTimer?: TriggerSchedulerTimer | null;
};


export let triggerSchedulerTimer: TriggerSchedulerTimer | null = null;

export let triggerSweepRunning = false;

// Connector reconcile sweep — runs on a slower cadence than the trigger sweep.

export let connectorSweepRunning = false;

export let lastConnectorSweepAt = 0;

export function connectorSweepIntervalMs() {
  const raw = Number(process.env.KORTIX_CONNECTOR_SWEEP_INTERVAL_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 120_000;
}


export function triggerSchedulerIntervalMs() {
  const raw = Number((config as any).KORTIX_TRIGGER_SCHEDULER_INTERVAL_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 60_000;
}


export function nextCronRun(schedule: string, from: Date, timezone?: string): Date | null {
  const job = new Cron(schedule, { paused: true, ...(timezone ? { timezone } : {}) });
  return job.nextRun(from);
}

/**
 * Walks every active project's git repo for `.opencode/triggers/*.md` and
 * fires due cron triggers. Triggers are 100% file-defined now (kortix.toml);
 * the old DB-backed trigger tables have been removed.
 */

export async function runProjectTriggerSweep(now = new Date()): Promise<{
  scanned: number;
  fired: number;
  queued: number;
  failed: number;
  skipped: number;
}> {
  if (triggerSweepRunning) return { scanned: 0, fired: 0, queued: 0, failed: 0, skipped: 0 };
  triggerSweepRunning = true;
  const result = { scanned: 0, fired: 0, queued: 0, failed: 0, skipped: 0 };
  try {
    await runGitTriggerSweep(now, result);
    return result;
  } catch (err) {
    console.error('[project-triggers/git] sweep failed', err);
    return result;
  } finally {
    triggerSweepRunning = false;
  }
}

/**
 * Reconcile every active project's connector DB cache against its kortix.toml.
 * This is the reliability backstop for connectors: the UI CRUD path and the
 * CR-merge hook reconcile inline, but a raw `git push` / `kortix` CLI edit that
 * bypasses both is only caught here. We invalidate the git mirror per project
 * so an out-of-band manifest edit is seen this sweep (not up to a minute later,
 * behind the mirror refresh throttle). `syncProjectConnectors` is hash-aware,
 * so unchanged connectors cost a manifest read, not a catalog re-fetch.
 */

export async function runProjectConnectorSweep(): Promise<{ scanned: number; synced: number; errors: number }> {
  if (connectorSweepRunning) return { scanned: 0, synced: 0, errors: 0 };
  connectorSweepRunning = true;
  const out = { scanned: 0, synced: 0, errors: 0 };
  try {
    const { syncProjectConnectors } = await import('../../executor/sync');
    const projectsForSweep = await db
      .select()
      .from(projects)
      .where(eq(projects.status, 'active'))
      .limit(200);
    for (const project of projectsForSweep) {
      out.scanned += 1;
      try {
        invalidateProjectMirror(project.projectId);
        const res = await syncProjectConnectors(project.projectId, project.accountId);
        out.synced += res.synced;
        out.errors += res.errors.length;
      } catch (err) {
        out.errors += 1;
        console.warn('[project-connectors] sweep failed', project.projectId, err instanceof Error ? err.message : err);
      }
    }
    return out;
  } finally {
    connectorSweepRunning = false;
  }
}

// ─── Git-backed triggers ────────────────────────────────────────────────────
//
// Triggers can ALSO live in the project repo at `.opencode/triggers/<slug>.md`
// — see ./triggers.ts for the file format. The repo is the source of truth
// for config (cron expr, prompt, secret_env reference). Runtime state
// (last_fired_at) lives in `project_trigger_runtime` because writing the
// repo on every fire would amplify a 5s scheduler tick into a flood of
// git commits.

/**
 * Find a user we can attribute trigger-spawned sessions to. Git-backed
 * triggers don't have a `created_by` like the DB-backed ones do — we pick
 * the account's first owner as a stable, audit-friendly stand-in.
 */

export async function resolveGitTriggerActor(accountId: string): Promise<string | null> {
  const [row] = await db
    .select({ userId: accountMembers.userId })
    .from(accountMembers)
    .where(and(
      eq(accountMembers.accountId, accountId),
      eq(accountMembers.accountRole, 'owner'),
    ))
    .limit(1);
  return row?.userId ?? null;
}


export function isGitCronSpecDue(spec: GitTriggerSpec, lastFiredAt: Date | null, now: Date): boolean {
  // One-off ("run once") schedules: fire exactly once at/after `runAt`. The
  // last_fired_at stamp written on the first fire keeps it dormant forever
  // after — no cron, no self-disable needed.
  if (spec.runAt) {
    if (lastFiredAt) return false;
    const at = Date.parse(spec.runAt);
    return !Number.isNaN(at) && at <= now.getTime();
  }
  if (!spec.cron) return false;
  try {
    const baseline = lastFiredAt ?? new Date(0);
    const next = nextCronRun(spec.cron, baseline, spec.timezone);
    return Boolean(next && next.getTime() <= now.getTime());
  } catch {
    return false;
  }
}


export async function getGitTriggerRuntime(projectId: string, slug: string) {
  const [row] = await db
    .select()
    .from(projectTriggerRuntime)
    .where(and(
      eq(projectTriggerRuntime.projectId, projectId),
      eq(projectTriggerRuntime.slug, slug),
    ))
    .limit(1);
  return row ?? null;
}


export async function markGitTriggerFired(projectId: string, slug: string, when: Date) {
  await db
    .insert(projectTriggerRuntime)
    .values({ projectId, slug, lastFiredAt: when, updatedAt: when })
    .onConflictDoUpdate({
      target: [projectTriggerRuntime.projectId, projectTriggerRuntime.slug],
      set: { lastFiredAt: when, updatedAt: when },
    });
}

/**
 * Fire a git-backed trigger. Triggers are file-defined (kortix.toml), so there
 * is no DB trigger/event row — the project_sessions row carries `trigger_slug`
 * in metadata so audits can still reconstruct the firing path.
 */

export async function fireGitTrigger(input: {
  spec: GitTriggerSpec;
  project: ProjectRow;
  payload: Record<string, unknown>;
  renderedPrompt: string;
  source: 'cron' | 'webhook' | 'manual';
  request?: RequestAuditContext;
}): Promise<{ status: 'fired' | 'queued' | 'failed'; sessionId?: string; error?: string; reason?: string }> {
  const { spec, project, payload, renderedPrompt, source } = input;
  const backpressure = await triggerBackpressureState(project.accountId, project.projectId);

  if (backpressure.shouldQueue) {
    return {
      status: 'queued',
      reason: backpressure.provisioning >= backpressure.projectProvisioningLimit
        ? 'project provisioning backpressure'
        : 'account session cap',
    };
  }

  const actor = await resolveGitTriggerActor(project.accountId);
  if (!actor) {
    return { status: 'failed', error: 'No account owner available to own the session' };
  }

  const sessionResult = await createProjectSession({
    project,
    userId: actor,
    enforceAccountCap: false,
    request: input.request,
    body: {
      agent_name: spec.agent,
      initial_prompt: renderedPrompt,
      metadata: {
        trigger_source: source,
        trigger_kind: 'git',
        trigger_slug: spec.slug,
        trigger_type: spec.type,
      },
    },
    metadata: {
      trigger_source: source,
      trigger_kind: 'git',
      trigger_slug: spec.slug,
      trigger_type: spec.type,
      payload_summary: summarizeTriggerPayload(payload),
    },
  });

  if (sessionResult.error) {
    return {
      status: 'failed',
      error: String(sessionResult.error.body.error ?? 'Failed to create trigger session'),
    };
  }
  return { status: 'fired', sessionId: sessionResult.row!.sessionId };
}


export function summarizeTriggerPayload(payload: Record<string, unknown>): Record<string, unknown> {
  // Strip the rendered body from session metadata — sessions already get the
  // prompt as KORTIX_INITIAL_PROMPT, and we don't want huge payloads in
  // postgres jsonb.
  const { rendered_body: _r, ...rest } = payload as Record<string, unknown>;
  return rest;
}

/**
 * Walk all active projects, load their git-backed triggers, and fire any
 * cron triggers that are due. Runtime state (last_fired_at) lives in
 * `project_trigger_runtime`, keyed by project + slug.
 *
 * We swallow per-project errors so one busted repo can't break the sweep
 * for everyone else.
 */

export async function runGitTriggerSweep(now: Date, accumulator: {
  scanned: number; fired: number; queued: number; failed: number; skipped: number;
}): Promise<void> {
  const projectsForSweep = await db
    .select()
    .from(projects)
    .where(eq(projects.status, 'active'))
    .limit(200);

  for (const project of projectsForSweep) {
    let specs: GitTriggerSpec[];
    try {
      const loaded = await loadProjectTriggers(await withProjectGitAuth(project));
      specs = loaded.specs;
    } catch (err) {
      console.warn('[project-triggers/git] load failed', project.projectId, err instanceof Error ? err.message : err);
      continue;
    }

    for (const spec of specs) {
      if (spec.type !== 'cron' || !spec.enabled) continue;
      accumulator.scanned += 1;

      const runtime = await getGitTriggerRuntime(project.projectId, spec.slug);
      const lastFired = runtime?.lastFiredAt ?? null;
      if (!isGitCronSpecDue(spec, lastFired, now)) {
        accumulator.skipped += 1;
        continue;
      }

      // Mark fired BEFORE the actual fire — a slow tick must never spawn
      // two sessions for the same scheduled run.
      await markGitTriggerFired(project.projectId, spec.slug, now);

      const payload = {
        cron: {
          schedule: spec.cron ?? spec.runAt,
          timezone: spec.timezone,
          fired_at: now.toISOString(),
          last_fired_at: lastFired?.toISOString() ?? null,
        },
        trigger: { slug: spec.slug, type: spec.type, kind: 'git' },
      };
      const renderedPrompt = renderPromptTemplate(spec.promptTemplate, payload);

      const result = await fireGitTrigger({
        spec,
        project,
        payload,
        renderedPrompt,
        source: 'cron',
      });
      if (result.status === 'fired') accumulator.fired += 1;
      else if (result.status === 'queued') accumulator.queued += 1;
      else accumulator.failed += 1;
    }
  }
}


export function startProjectTriggerScheduler(): void {
  if ((config as any).KORTIX_TRIGGER_SCHEDULER_ENABLED === false) return;
  if (globalForProjectTriggers.__kortixProjectTriggerSchedulerTimer) {
    clearInterval(globalForProjectTriggers.__kortixProjectTriggerSchedulerTimer);
  }
  triggerSchedulerTimer = setInterval(() => {
    runProjectTriggerSweep().then((result) => {
      if (result.fired || result.queued || result.failed) {
        console.log('[project-triggers] sweep completed', result);
      }
    }).catch((error) => {
      console.error('[project-triggers] sweep failed:', error);
    });

    // Same cadence drives the [[apps]] auto-deploy sweep. Run independently
    // so a slow app deploy never blocks the cron trigger fires. Skipped
    // entirely when the experimental flag is off — no point reading
    // every project's manifest just to ignore the `apps` block.
    if (config.KORTIX_APPS_EXPERIMENTAL) {
      runProjectAppSweep().then((result) => {
        if (result.deployed || result.failed) {
          console.log('[project-apps] sweep completed', result);
        }
      }).catch((error) => {
        console.error('[project-apps] sweep failed:', error);
      });
    }

    // Connector reconcile backstop — slower cadence than the trigger sweep so
    // we don't re-read every manifest each tick. Catches out-of-band manifest
    // edits (raw git push / CLI) and heals any DB drift / retries error rows.
    if (Date.now() - lastConnectorSweepAt >= connectorSweepIntervalMs()) {
      lastConnectorSweepAt = Date.now();
      runProjectConnectorSweep().then((result) => {
        if (result.synced || result.errors) {
          console.log('[project-connectors] sweep completed', result);
        }
      }).catch((error) => {
        console.error('[project-connectors] sweep failed:', error);
      });
    }

  }, triggerSchedulerIntervalMs());
  globalForProjectTriggers.__kortixProjectTriggerSchedulerTimer = triggerSchedulerTimer;
}


export function stopProjectTriggerScheduler(): void {
  if (triggerSchedulerTimer) {
    clearInterval(triggerSchedulerTimer);
    triggerSchedulerTimer = null;
  }
  if (globalForProjectTriggers.__kortixProjectTriggerSchedulerTimer) {
    clearInterval(globalForProjectTriggers.__kortixProjectTriggerSchedulerTimer);
    globalForProjectTriggers.__kortixProjectTriggerSchedulerTimer = null;
  }
}

// GET /v1/projects

export function buildPublicWebhookUrl(projectId: string, slug: string): string {
  const root = deriveKortixApiRoot(config.KORTIX_URL);
  return `${root}/v1/webhooks/projects/${projectId}/${slug}`;
}

// ── Git-backed trigger CRUD helpers ─────────────────────────────────────────

/** Builds the GET-listing response shape (specs + runtime + errors). */

export async function loadTriggersForResponse(projectId: string, project: ProjectRow) {
  const { specs, errors } = await loadProjectTriggers(await withProjectGitAuth(project));
  const runtimeRows = specs.length === 0
    ? []
    : await db
        .select()
        .from(projectTriggerRuntime)
        .where(eq(projectTriggerRuntime.projectId, projectId));
  const lastFiredBySlug = new Map(
    runtimeRows.map((row) => [row.slug, row.lastFiredAt?.toISOString() ?? null]),
  );

  return {
    triggers: specs.map((spec) => ({
      slug: spec.slug,
      path: spec.path,
      name: spec.name,
      type: spec.type,
      agent: spec.agent,
      enabled: spec.enabled,
      cron: spec.cron,
      run_at: spec.runAt,
      timezone: spec.timezone,
      secret_env: spec.secretEnv,
      prompt_template: spec.promptTemplate,
      last_fired_at: lastFiredBySlug.get(spec.slug) ?? null,
      webhook_url:
        spec.type === 'webhook'
          ? buildPublicWebhookUrl(projectId, spec.slug)
          : null,
    })),
    errors,
  };
}


export interface TriggerDraft {
  slug: string;
  name: string;
  type: 'cron' | 'webhook';
  agent: string;
  enabled: boolean;
  promptTemplate: string;
  cron: string | null;
  runAt: string | null;
  timezone: string;
  secretEnv: string | null;
}


export function parseTriggerDraft(
  body: Record<string, unknown>,
  opts: { existingSlug: string | null },
): TriggerDraft | { error: string } {
  const rawSlug = normalizeString((body as any).slug);
  const name = normalizeString((body as any).name);
  if (!name) return { error: 'name is required' };

  const slug = opts.existingSlug
    ?? rawSlug
    ?? slugify(name);
  if (!/^[a-z0-9][a-z0-9_-]{0,127}$/.test(slug)) {
    return { error: `Invalid slug "${slug}" — use letters, digits, dashes, underscores only` };
  }

  const type = (body as any).type === 'webhook' ? 'webhook' : (body as any).type === 'cron' ? 'cron' : null;
  if (!type) return { error: 'type must be "cron" or "webhook"' };

  const promptTemplate = normalizeString((body as any).prompt_template ?? (body as any).promptTemplate);
  if (!promptTemplate) return { error: 'prompt_template is required' };

  const agent = normalizeString((body as any).agent ?? (body as any).agent_name) ?? 'default';
  const enabled = normalizeBoolean((body as any).enabled) ?? true;

  if (type === 'cron') {
    const timezone = normalizeString((body as any).timezone) ?? 'UTC';
    // One-off ("run once") schedules carry `run_at` instead of `cron`.
    const runAtRaw = normalizeString((body as any).run_at ?? (body as any).runAt);
    if (runAtRaw) {
      const parsed = Date.parse(runAtRaw);
      if (Number.isNaN(parsed)) {
        return { error: `run_at must be an ISO-8601 datetime (got "${runAtRaw}")` };
      }
      return {
        slug,
        name,
        type: 'cron',
        agent,
        enabled,
        promptTemplate,
        cron: null,
        runAt: new Date(parsed).toISOString(),
        timezone,
        secretEnv: null,
      };
    }
    const cron = normalizeString((body as any).cron ?? (body as any).schedule);
    if (!cron) return { error: 'cron triggers must declare a `cron` expression or a one-off `run_at`' };
    return {
      slug,
      name,
      type: 'cron',
      agent,
      enabled,
      promptTemplate,
      cron,
      runAt: null,
      timezone,
      secretEnv: null,
    };
  }

  const secretEnv = normalizeString((body as any).secret_env ?? (body as any).secretEnv);
  if (!secretEnv) return { error: 'webhook triggers must declare `secret_env`' };
  if (!/^[A-Z_][A-Z0-9_]*$/.test(secretEnv)) {
    return { error: `secret_env must look like a project_secrets name (got "${secretEnv}")` };
  }
  return {
    slug,
    name,
    type: 'webhook',
    agent,
    enabled,
    promptTemplate,
    cron: null,
    runAt: null,
    timezone: 'UTC',
    secretEnv,
  };
}

/** Convert an existing spec back to body shape so we can splat it into a
 * PATCH merge before re-parsing. */

export function specToBody(spec: GitTriggerSpec): Record<string, unknown> {
  return {
    slug: spec.slug,
    name: spec.name,
    type: spec.type,
    agent: spec.agent,
    enabled: spec.enabled,
    prompt_template: spec.promptTemplate,
    cron: spec.cron,
    timezone: spec.timezone,
    secret_env: spec.secretEnv,
  };
}


export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 128) || 'trigger';
}


export function draftToSpec(draft: TriggerDraft): GitTriggerSpec {
  return {
    slug: draft.slug,
    path: `${MANIFEST_FILENAME}#triggers.${draft.slug}`,
    name: draft.name,
    type: draft.type,
    agent: draft.agent,
    enabled: draft.enabled,
    promptTemplate: draft.promptTemplate,
    cron: draft.cron,
    runAt: draft.runAt,
    timezone: draft.timezone,
    secretEnv: draft.secretEnv,
  };
}

/**
 * Read the project's manifest. If kortix.toml doesn't exist yet (brand-new
 * repo), synthesize a minimal valid one so the first POST /triggers can
 * scaffold it on save.
 */

export async function loadManifestForEdit(project: ProjectRow): Promise<ParsedManifest> {
  const existing = await readManifest(await withProjectGitAuth(project));
  if (existing) return existing;
  return {
    schemaVersion: KNOWN_SCHEMA_VERSION,
    raw: {
      project: { name: project.name, description: '' },
      runtime: { root: '.opencode' },
      env: { required: [], optional: [] },
    },
  };
}

/** Insert or replace a trigger by slug inside the manifest's triggers array. */

export function upsertTriggerInManifest(
  manifest: ParsedManifest,
  spec: GitTriggerSpec,
): ParsedManifest {
  const current = Array.isArray(manifest.raw.triggers)
    ? (manifest.raw.triggers as Record<string, unknown>[])
    : [];
  const idx = current.findIndex(
    (entry) => typeof entry?.slug === 'string' && entry.slug === spec.slug,
  );
  const entry = triggerSpecToTomlEntry(spec);
  const next = current.slice();
  if (idx >= 0) next[idx] = entry;
  else next.push(entry);
  return { ...manifest, raw: { ...manifest.raw, triggers: next } };
}

/** Remove a trigger by slug from the manifest's triggers array. */

export function removeTriggerFromManifest(
  manifest: ParsedManifest,
  slug: string,
): ParsedManifest {
  const current = Array.isArray(manifest.raw.triggers)
    ? (manifest.raw.triggers as Record<string, unknown>[])
    : [];
  const next = current.filter(
    (entry) => !(typeof entry?.slug === 'string' && entry.slug === slug),
  );
  return { ...manifest, raw: { ...manifest.raw, triggers: next } };
}

/**
 * Commit a new revision of kortix.toml to the project's default branch.
 * All trigger CRUD funnels through this — one file, one commit per edit.
 */

export async function commitManifest(
  project: ProjectRow,
  manifest: ParsedManifest,
  message: string,
): Promise<{ ok: true } | { error: string; status: number }> {
  const content = serializeManifest(manifest);
  const branch = project.defaultBranch;

  // GitHub repos: commit through the Contents API (App / PAT auth) — the
  // lightweight single-file path that doesn't need a full clone.
  const repo = parseGitHubRepoUrl(project.repoUrl);
  if (repo) {
    let auth: GitHubAuthContext | undefined;
    try {
      auth = (await resolveProjectGitAuth(project)).auth ?? undefined;
    } catch (err) {
      return { error: `GitHub auth unavailable: ${(err as Error).message || String(err)}`, status: 502 };
    }
    const existingSha = await getFileSha({ owner: repo.owner, repo: repo.repo, path: MANIFEST_FILENAME, branch, auth });
    try {
      await commitFile({
        owner: repo.owner,
        repo: repo.repo,
        path: MANIFEST_FILENAME,
        content,
        message,
        branch,
        existingSha: existingSha ?? undefined,
        auth,
      });
    } catch (err) {
      return { error: `Failed to commit ${MANIFEST_FILENAME}: ${(err as Error).message || String(err)}`, status: 502 };
    }
    invalidateProjectMirror(project.projectId);
    return { ok: true };
  }

  // Any other host (GitLab, generic HTTPS remote): commit via the git CLI.
  // The old code bailed here with "Project repo URL is
  // not a GitHub URL", which broke every manifest edit (connectors, triggers,
  // apps) on managed/self-hosted projects. Mirrors createRemoteSessionBranch's
  // GitHub-fast-path / git-CLI-fallback split.
  let gitProject: ProjectRow & { gitAuthToken: string | null };
  try {
    gitProject = await withProjectGitAuth(project);
  } catch (err) {
    return { error: `Git auth unavailable: ${(err as Error).message || String(err)}`, status: 502 };
  }
  if (!gitProject.gitAuthToken) {
    return { error: 'No git credentials available to write to the project repo', status: 502 };
  }

  try {
    await commitFileToBranch(gitProject, {
      path: MANIFEST_FILENAME,
      content,
      message,
      branch,
      authorName: 'Kortix',
      authorEmail: 'noreply@kortix.ai',
    });
  } catch (err) {
    return { error: `Failed to commit ${MANIFEST_FILENAME}: ${(err as Error).message || String(err)}`, status: 502 };
  }

  invalidateProjectMirror(project.projectId);
  return { ok: true };
}

// POST /v1/projects/:projectId/triggers
//
// Creates a new trigger file in the project repo at
// `.opencode/triggers/<slug>.md`. The slug is derived from the body's `slug`
// (or `name`) and validated for URL safety. Body shape:
//   { slug?, name, type: 'cron'|'webhook', agent?, enabled?,
//     prompt_template, cron?, timezone?, secret_env? }
