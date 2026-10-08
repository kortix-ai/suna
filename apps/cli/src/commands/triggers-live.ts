import { formatDurationSeconds } from '@kortix/manifest-schema';
import type { ApiClient } from '../api/client.ts';
import type { ProjectTriggerEvent, ProjectTriggersResponse } from '../api/types.ts';
import {
  
  emitJson,
  fail,
  missing,
  resolveProjectContext,
  surfaceApiError,

  type CtxOpts,
} from '../command-helpers.ts';
import { C, status } from '../style.ts';
import { checkEventConfig, eventNextStep } from './triggers-events.ts';
import { parseEventFlags, parseMonitorFlags, strayEventFlag } from './triggers-manifest.ts';

// ── The LIVE path (--apply, and every `set`) ───────────────────────────────
//
// `add`/`rm`/`enable`/`disable` still edit the local kortix.yaml by default —
// the manifest is the source of truth and `kortix ship` applies it (see
// triggers-manifest.ts). `--apply` takes the other door the dashboard uses: the
// API commits kortix.yaml on main itself and reconciles the runtime in the same
// request. Same destination, no ship, no change request.

/** Repeatable live-only flags, already collected. */
interface LiveOpts {
  members: string[];
  groups: string[];
  filters: string[];
}

/** `path=value` pairs → the payload filter the API stores. */
function parseFilters(raw: readonly string[]): Record<string, string> | { error: string } {
  const filter: Record<string, string> = {};
  for (const entry of raw) {
    const index = entry.indexOf('=');
    if (index <= 0) {
      return { error: `--filter must look like path=value (got "${entry}")` };
    }
    const path = entry.slice(0, index).trim();
    const value = entry.slice(index + 1);
    if (!path) return { error: `--filter needs a payload path (got "${entry}")` };
    filter[path] = value;
  }
  return filter;
}

/**
 * Build `session_access` from --session-access / --member / --group.
 *
 * Naming a principal IS the opt-in to `members`, so `--member <id>` alone is a
 * complete instruction. Returns undefined when the caller said nothing, so a
 * PATCH does not rewrite an access policy it was not asked about.
 */
function buildSessionAccess(
  mode: string | undefined,
  live: LiveOpts,
): { mode: string; memberIds: string[]; groupIds: string[] } | undefined | { error: string } {
  const named = live.members.length + live.groups.length > 0;
  if (!mode && !named) return undefined;
  const resolved = mode ?? 'members';
  if (resolved !== 'private' && resolved !== 'project' && resolved !== 'members') {
    return { error: '--session-access must be private, project, or members.' };
  }
  if (resolved !== 'members' && named) {
    return {
      error: `--member/--group name who may open the session, which only applies to --session-access members (got ${resolved}).`,
    };
  }
  return { mode: resolved, memberIds: live.members, groupIds: live.groups };
}

/** Shared session wiring for both create and update bodies. */
function sessionFields(tf: Record<string, string | undefined>): Record<string, unknown> {
  return {
    ...(tf.sessionMode ? { session_mode: tf.sessionMode } : {}),
    ...(tf.sessionKey ? { session_key: tf.sessionKey } : {}),
    ...(tf.sessionId ? { session_id: tf.sessionId } : {}),
  };
}

export async function triggersAddLive(
  slug: string | undefined,
  tf: Record<string, string | undefined>,
  disabled: boolean,
  live: LiveOpts,
  opts: CtxOpts,
  json = false,
): Promise<number> {
  if (!slug) return missing('a trigger slug');
  const type = (tf.type ?? 'cron').toLowerCase();
  if (type !== 'cron' && type !== 'webhook' && type !== 'monitor' && type !== 'event') {
    return fail('--type must be cron, webhook, monitor, or event.');
  }
  if (!tf.prompt) return fail('--prompt is required.');
  if (type !== 'event') {
    const stray = strayEventFlag(tf);
    if (stray) return fail(stray);
  }
  if (tf.cron && tf.runAt) return fail('--cron and --run-at are exclusive — pass one.');
  if (type === 'cron' && !tf.cron && !tf.runAt) {
    return fail('cron triggers need --cron "<6-field expr>" or --run-at <iso>.');
  }
  if (type === 'webhook' && !tf.secretEnv) {
    return fail('webhook triggers need --secret-env <NAME>.');
  }

  const filter = parseFilters(live.filters);
  if ('error' in filter) return fail(filter.error);
  const access = buildSessionAccess(tf.sessionAccess, live);
  if (access && 'error' in access) return fail(access.error);

  let event: ReturnType<typeof parseEventFlags> | null = null;
  const body: Record<string, unknown> = {
    slug,
    name: tf.name ?? slug,
    type,
    prompt_template: tf.prompt,
    enabled: !disabled,
    ...(tf.agent ? { agent: tf.agent } : {}),
    ...(tf.model ? { model: tf.model } : {}),
    ...sessionFields(tf),
    ...(access ? { session_access: access } : {}),
    ...(Object.keys(filter).length > 0 ? { filter } : {}),
  };
  if (type === 'cron') {
    if (tf.runAt) body.run_at = tf.runAt;
    else body.cron = tf.cron;
    body.timezone = tf.timezone ?? 'UTC';
  } else if (type === 'webhook') {
    body.secret_env = tf.secretEnv;
  } else if (type === 'event') {
    const parsed = parseEventFlags(tf);
    if ('error' in parsed) return fail(parsed.error);
    event = parsed;
    body.connector = parsed.connector;
    body.event = parsed.event;
  } else {
    // A monitor rejects cron/webhook wiring outright, so send only its own
    // fields — the same validation `kortix triggers add` runs locally.
    const monitor = parseMonitorFlags(tf);
    if ('error' in monitor) return fail(monitor.error);
    body.run = monitor.run;
    body.mode = monitor.mode;
    if (monitor.intervalSeconds !== null) {
      body.interval = formatDurationSeconds(monitor.intervalSeconds);
    }
    if (monitor.expectEventWithinSeconds !== null) {
      body.expect_event_within = formatDurationSeconds(monitor.expectEventWithinSeconds);
    }
  }

  const ctx = await resolveProjectContext(opts);
  if (!ctx) return 1;
  let eventName: string | undefined;
  if (event && !('error' in event)) {
    const checked = await checkEventConfig(ctx, event.connector, event.event, event.config);
    if ('error' in checked) return fail(checked.error);
    eventName = checked.eventName;
    if (Object.keys(checked.config).length > 0) body.event_config = checked.config;
  }
  let resp: ProjectTriggersResponse;
  try {
    resp = await ctx.client.post<ProjectTriggersResponse>(
      `/projects/${ctx.projectId}/triggers`,
      body,
    );
  } catch (err) {
    return surfaceApiError(err);
  }
  if (json) {
    emitJson(resp);
    return 0;
  }
  process.stdout.write(
    `${status.ok(`${C.bold}${slug}${C.reset} (${type}) live on the project`)} ${C.dim}(committed to kortix.yaml on main + reconciled)${C.reset}\n`,
  );
  reportWebhookUrl(resp, slug);
  const created = resp.triggers?.find((t) => t.slug === slug);
  if (created?.type === 'event') {
    for (const line of eventNextStep(created, eventName).lines) {
      process.stdout.write(`  ${C.dim}${line}${C.reset}\n`);
    }
  }
  return 0;
}

/**
 * PATCH only the fields the caller named.
 *
 * The API merges the patch onto the trigger's current spec, so an untouched
 * field keeps its value — which is exactly why `--cron` must null `run_at` and
 * vice versa. The merge base carries BOTH, and a one-off `run_at` outranks a
 * `cron` when both survive, so a patch that only set `cron` would silently
 * leave the trigger a one-off. The dashboard nulls the other field for the same
 * reason.
 */
export async function triggersSetLive(
  slug: string | undefined,
  tf: Record<string, string | undefined>,
  live: LiveOpts,
  opts: CtxOpts,
  json = false,
): Promise<number> {
  if (!slug) return missing('a trigger slug');
  if (tf.cron && tf.runAt) return fail('--cron and --run-at are exclusive — pass one.');

  const filter = parseFilters(live.filters);
  if ('error' in filter) return fail(filter.error);
  const access = buildSessionAccess(tf.sessionAccess, live);
  if (access && 'error' in access) return fail(access.error);

  let enabled: boolean | undefined;
  if (tf.enabled !== undefined) {
    if (tf.enabled !== 'true' && tf.enabled !== 'false') {
      return fail('--enabled must be true or false.');
    }
    enabled = tf.enabled === 'true';
  }

  const body: Record<string, unknown> = {
    ...(tf.name ? { name: tf.name } : {}),
    ...(tf.prompt ? { prompt_template: tf.prompt } : {}),
    ...(tf.agent ? { agent: tf.agent } : {}),
    ...(tf.model ? { model: tf.model } : {}),
    ...(tf.secretEnv ? { secret_env: tf.secretEnv } : {}),
    ...(tf.connector ? { connector: tf.connector } : {}),
    ...(tf.event ? { event: tf.event } : {}),
    ...(enabled === undefined ? {} : { enabled }),
    ...sessionFields(tf),
    ...(access ? { session_access: access } : {}),
    ...(live.filters.length > 0 ? { filter } : {}),
  };
  // A bare schedule update must not clobber the trigger's stored timezone with
  // a UTC default (KRTX-1338): send timezone only when the caller passes one.
  if (tf.cron) {
    body.cron = tf.cron;
    body.run_at = null;
  } else if (tf.runAt) {
    body.run_at = tf.runAt;
    body.cron = null;
  }
  if (tf.timezone) {
    body.timezone = tf.timezone;
  }
  const touchesEvent = tf.connector || tf.event || tf.eventConfig;
  if (Object.keys(body).length === 0 && !touchesEvent) {
    return fail('Pass at least one field to change (see `kortix triggers --help`).');
  }

  const ctx = await resolveProjectContext(opts);
  if (!ctx) return 1;
  if (touchesEvent) {
    const found = await currentEvent(ctx, slug);
    if ('problem' in found) return fail(found.problem);
    const current = found.event;
    const connector = tf.connector ?? current.connector;
    const event = tf.event ?? current.type;
    // --config-json replaces; bare --config merges. A different event
    // starts from an empty config: the old fields belong to the old event.
    const replace = tf.eventConfigReplace !== undefined || event !== current.type || connector !== current.connector;
    const config = {
      ...(replace ? {} : current.config),
      ...(tf.eventConfig ? (JSON.parse(tf.eventConfig) as Record<string, unknown>) : {}),
    };
    const checked = await checkEventConfig(ctx, connector, event, config);
    if ('error' in checked) return fail(checked.error);
    body.event_config = checked.config;
  }
  let resp: ProjectTriggersResponse;
  try {
    resp = await ctx.client.patch<ProjectTriggersResponse>(
      `/projects/${ctx.projectId}/triggers/${encodeURIComponent(slug)}`,
      body,
    );
  } catch (err) {
    return surfaceApiError(err);
  }
  if (json) {
    emitJson(resp);
    return 0;
  }
  const changed = Object.keys(body).sort().join(', ');
  process.stdout.write(
    `${status.ok(`Updated ${C.bold}${slug}${C.reset}`)} ${C.dim}(${changed})${C.reset}\n`,
  );
  const updated = resp.triggers?.find((t) => t.slug === slug);
  if (touchesEvent && updated?.type === 'event') {
    for (const line of eventNextStep(updated).lines) {
      process.stdout.write(`  ${C.dim}${line}${C.reset}\n`);
    }
  }
  return 0;
}

/** The trigger's current event source, for merging a partial `set`. */
async function currentEvent(
  ctx: { client: ApiClient; projectId: string },
  slug: string,
): Promise<{ event: ProjectTriggerEvent } | { problem: string }> {
  try {
    const resp = await ctx.client.get<ProjectTriggersResponse>(`/projects/${ctx.projectId}/triggers`);
    const t = resp.triggers.find((x) => x.slug === slug);
    if (!t) return { problem: `No trigger "${slug}".` };
    if (t.type !== 'event' || !t.event) {
      return { problem: `${slug} is a ${t.type} trigger — --connector, --event, and --config only apply to event triggers.` };
    }
    return { event: t.event };
  } catch (err) {
    return { problem: (err as Error).message };
  }
}

export async function triggersRmLive(
  slug: string | undefined,
  opts: CtxOpts,
  json = false,
): Promise<number> {
  if (!slug) return missing('a trigger slug');
  const ctx = await resolveProjectContext(opts);
  if (!ctx) return 1;
  let resp: ProjectTriggersResponse;
  try {
    resp = await ctx.client.delete<ProjectTriggersResponse>(
      `/projects/${ctx.projectId}/triggers/${encodeURIComponent(slug)}`,
    );
  } catch (err) {
    return surfaceApiError(err);
  }
  if (json) {
    emitJson(resp);
    return 0;
  }
  process.stdout.write(
    `${status.ok(`Removed ${C.bold}${slug}${C.reset}`)} ${C.dim}(kortix.yaml on main + runtime state)${C.reset}\n`,
  );
  return 0;
}

export async function triggersToggleLive(
  slug: string | undefined,
  enabled: boolean,
  opts: CtxOpts,
  json = false,
): Promise<number> {
  if (!slug) return missing('a trigger slug');
  const ctx = await resolveProjectContext(opts);
  if (!ctx) return 1;
  let resp: ProjectTriggersResponse;
  try {
    resp = await ctx.client.patch<ProjectTriggersResponse>(
      `/projects/${ctx.projectId}/triggers/${encodeURIComponent(slug)}`,
      { enabled },
    );
  } catch (err) {
    return surfaceApiError(err);
  }
  if (json) {
    emitJson(resp);
    return 0;
  }
  process.stdout.write(
    `${status.ok(`${enabled ? 'Enabled' : 'Disabled'} ${C.bold}${slug}${C.reset}`)} ${C.dim}(kortix.yaml on main)${C.reset}\n`,
  );
  return 0;
}

/** A webhook trigger is useless until its caller has the URL — print it. */
function reportWebhookUrl(resp: ProjectTriggersResponse, slug: string): void {
  const created = resp.triggers?.find((t) => t.slug === slug);
  if (created?.webhook_url) {
    process.stdout.write(`  ${C.dim}webhook ${C.reset}${created.webhook_url}\n`);
  }
}
