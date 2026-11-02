/**
 * Triggers: one concept for kortix.yaml triggers and loops. A trigger is a
 * SOURCE (what fires it) plus a TARGET (what a fire does). A loop is a trigger
 * that wakes the session that created it.
 *
 *   source  schedule (cron, every, at, in) · webhook · connector event ·
 *           App event · change request merged
 *   target  agent    start a new session of that agent (a kortix.yaml trigger)
 *           session  wake one existing session (a loop)
 *           app      call an App (`target: { app }`, unchanged)
 *
 * Storage stays where it was. A declared trigger is a `triggers:` entry in
 * kortix.yaml. A runtime trigger is a `project_trigger_runtime` row the
 * manifest never declares: a loop (`reminder.<hex>`, `lib/session-reminders.ts`)
 * or a row created through `POST /triggers/runtime` (`trigger.<hex>`; rows made
 * before the rename carry `automation.<hex>` and stay valid). Its type
 * column is the source; `schedule_spec.reminder` set means the session target.
 * Code reads the row for both, never the slug prefix.
 */
import { randomBytes } from 'node:crypto';
import { projectTriggerRuntime } from '@kortix/db';
import type { TriggerList } from '@kortix/api-contract';
import { formatDurationSeconds } from '@kortix/manifest-schema';
import { and, asc, eq, like, or, sql } from 'drizzle-orm';
import { db } from '../../shared/db';
import { triggerScheduleRevision } from '../trigger-schedule';
import type { GitTriggerSpec, GitTriggerType } from '../triggers';
import { buildPublicWebhookUrl, draftToSpec, parseTriggerDraft } from './trigger-draft';
import { normalizeString } from './serializers';
import { type ReminderDraft, parseReminderDraft, reminderSpec, serializeSessionReminder } from './session-reminders';

export const RUNTIME_TRIGGER_ID_PREFIX = 'trigger.';
/** The prefix `POST /automations` used before the rename. Still read, never written. */
const LEGACY_RUNTIME_TRIGGER_ID_PREFIX = 'automation.';

export type TriggerSource = 'schedule' | 'webhook' | 'event' | 'app' | 'change_request';
export const TRIGGER_SOURCES: readonly TriggerSource[] = ['schedule', 'webhook', 'event', 'app', 'change_request'];

export type TriggerTarget =
  | { kind: 'agent'; agent: string }
  | { kind: 'session'; session_id: string }
  | { kind: 'app'; app: string };

export function newRuntimeTriggerId(): string {
  return `${RUNTIME_TRIGGER_ID_PREFIX}${randomBytes(6).toString('hex')}`;
}

/** A loop id or a runtime trigger id. A manifest slug has no `.`; an App run (`apprun.`) is not a trigger. */
export function isRuntimeTriggerSlug(slug: string): boolean {
  return /^(?:reminder|trigger|automation)\.[0-9a-f]{12}$/.test(slug);
}

export function triggerSourceOf(type: GitTriggerType): TriggerSource {
  return type === 'cron' ? 'schedule' : type;
}

/** What one fire does. `reminder` marks the session target; a pinned kortix.yaml trigger falls back to its agent, so it targets the agent. */
export function triggerTargetOf(spec: Pick<GitTriggerSpec, 'agent' | 'target' | 'reminder' | 'pinnedSessionId'>): TriggerTarget {
  if (spec.target?.app) return { kind: 'app', app: spec.target.app };
  // A session row whose pin was lost still dispatches to the session path, which pauses it.
  if (spec.reminder) return { kind: 'session', session_id: spec.pinnedSessionId as string };
  return { kind: 'agent', agent: spec.agent };
}

export interface MergedChangeRequest {
  cr_id: string;
  number?: number | null;
  title?: string | null;
  base_ref: string;
  head_ref?: string | null;
  merge_commit_sha?: string | null;
}

export function changeRequestMatches(spec: GitTriggerSpec, cr: Pick<MergedChangeRequest, 'cr_id' | 'base_ref'>): boolean {
  if (spec.type !== 'change_request') return false;
  const filter = spec.changeRequest;
  if (filter?.crId && filter.crId !== cr.cr_id) return false;
  if (filter?.base && filter.base !== cr.base_ref) return false;
  return true;
}

export interface RuntimeTriggerBody {
  name: string | null;
  prompt: string;
  source: TriggerSource;
  target: { kind: 'session'; session_id: string } | { kind: 'agent'; agent: string };
  /** Schedule into a session: the loop draft, parsed with the loop rules. */
  reminderDraft?: ReminderDraft;
  /** Every other case: a trigger-shaped body (`POST /triggers` keys). */
  triggerBody?: Record<string, unknown>;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Parse `POST /triggers/runtime`: `{ name?, prompt, source: { type, … }, target: { session_id } | { agent } }`.
 * A schedule into a session keeps the loop rules (5-minute floor, `in`/`at`);
 * any other combination keeps the trigger rules of its source.
 */
export function parseRuntimeTriggerBody(body: Record<string, unknown>, now: Date): RuntimeTriggerBody | { error: string } {
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  const name = normalizeString(body.name) ?? null;
  const source = isObject(body.source) ? body.source : null;
  const target = isObject(body.target) ? body.target : null;
  if (!source) return { error: 'source is required: { type, … }' };
  if (!target) return { error: 'target is required: { session_id } or { agent }' };
  const sessionId = normalizeString(target.session_id);
  const agent = normalizeString(target.agent);
  if (sessionId && agent) return { error: 'target takes session_id or agent, not both' };
  if (!sessionId && !agent) return { error: 'target is required: { session_id } or { agent }' };
  const parsedTarget = sessionId ? { kind: 'session' as const, session_id: sessionId } : { kind: 'agent' as const, agent: agent! };
  const type = normalizeString(source.type);
  if (!type || !(TRIGGER_SOURCES as readonly string[]).includes(type)) {
    return { error: `source.type must be one of ${TRIGGER_SOURCES.join(', ')}` };
  }
  const kind = type as TriggerSource;
  const common = { name, prompt, source: kind, target: parsedTarget };

  if (kind === 'schedule' && parsedTarget.kind === 'session') {
    const draft = parseReminderDraft({ ...source, prompt, name }, now);
    if ('error' in draft) return draft;
    return { ...common, reminderDraft: draft };
  }
  if (!prompt) return { error: 'prompt is required' };
  switch (kind) {
    case 'schedule': {
      const at = normalizeString(source.at);
      const delay = normalizeString(source.in);
      if (at && delay) return { error: 'Pass at or in, not both' };
      // `in` is a loop word; a trigger knows only an instant.
      let runAt = at;
      if (delay) {
        const draft = parseReminderDraft({ prompt, in: delay }, now);
        if ('error' in draft) return draft;
        runAt = draft.firstFireAt.toISOString();
      }
      return { ...common, triggerBody: { type: 'cron', cron: source.cron, every: source.every, run_at: runAt, timezone: source.timezone } };
    }
    case 'webhook':
      return { ...common, triggerBody: { type: 'webhook', secret_env: source.secret_env } };
    case 'event':
      return {
        ...common,
        triggerBody: {
          type: 'event',
          connector: source.connector,
          event: source.event ?? source.event_type,
          event_config: source.config ?? source.event_config ?? {},
          event_account: source.account ?? null,
          event_source: source.source ?? null,
        },
      };
    case 'app':
      return { ...common, triggerBody: { type: 'app', app: source.app } };
    case 'change_request':
      return { ...common, triggerBody: { type: 'change_request', cr_id: normalizeString(source.cr_id) ?? null, base: normalizeString(source.base) ?? null } };
  }
}

/** The spec a runtime trigger stores and the scheduler/receivers fire. */
export function runtimeTriggerSpec(input: {
  id: string;
  body: RuntimeTriggerBody;
  /** The target agent, or the target session's own agent. */
  agent: string;
  now: Date;
  promptAuthorUserId?: string | null;
}): GitTriggerSpec | { error: string } {
  const { body, id } = input;
  const session = body.target.kind === 'session' ? body.target.session_id : null;
  if (body.reminderDraft && session) {
    return reminderSpec({ id, sessionId: session, agent: input.agent, draft: body.reminderDraft, now: input.now, promptAuthorUserId: input.promptAuthorUserId });
  }
  const triggerBody = body.triggerBody ?? {};
  let spec: GitTriggerSpec;
  if (triggerBody.type === 'change_request') {
    spec = {
      slug: id, path: '', name: body.name ?? id, type: 'change_request', agent: input.agent, model: null, enabled: true,
      promptTemplate: body.prompt, cron: null, runAt: null, timezone: 'UTC', secretEnv: null,
      sessionMode: 'fresh', pinnedSessionId: null, sessionKey: null, filter: null,
      changeRequest: { crId: (triggerBody.cr_id as string | null) ?? null, base: (triggerBody.base as string | null) ?? null },
    };
  } else {
    const draft = parseTriggerDraft(
      { ...triggerBody, name: body.name ?? id, prompt_template: body.prompt, agent: input.agent },
      { existingSlug: 'trigger' },
    );
    if ('error' in draft) return draft;
    spec = { ...draftToSpec(draft), slug: id, path: '', name: body.name ?? id };
  }
  if (!session) return spec;
  return {
    ...spec,
    sessionMode: 'pinned',
    pinnedSessionId: session,
    reminder: {
      everySeconds: null,
      createdAt: input.now.toISOString(),
      ...(input.promptAuthorUserId ? { promptAuthorUserId: input.promptAuthorUserId } : {}),
    },
  };
}

type RuntimeRow = typeof projectTriggerRuntime.$inferSelect;

/** The source half of a list row: its type plus the fields that type uses. */
function sourceFields(
  projectId: string,
  spec: Pick<GitTriggerSpec, 'slug' | 'type' | 'cron' | 'runAt' | 'timezone' | 'everySeconds' | 'secretEnv' | 'event' | 'app' | 'changeRequest' | 'reminder'>,
): Record<string, unknown> {
  const type = triggerSourceOf(spec.type);
  if (type === 'schedule') {
    const every = spec.everySeconds ?? spec.reminder?.everySeconds ?? null;
    return { type, cron: spec.cron, every: every ? formatDurationSeconds(every) : null, at: spec.runAt, timezone: spec.timezone };
  }
  if (type === 'webhook') return { type, secret_env: spec.secretEnv, webhook_url: buildPublicWebhookUrl(projectId, spec.slug) };
  if (type === 'event') return { type, connector: spec.event?.connector ?? null, event: spec.event?.type ?? null, account: spec.event?.account ?? null };
  if (type === 'app') return { type, app: spec.app ?? null };
  return { type, cr_id: spec.changeRequest?.crId ?? null, base: spec.changeRequest?.base ?? null };
}

/** One `GET /triggers/all` row for a runtime trigger (a loop or a `POST /triggers/runtime` row). */
export function serializeRuntimeTrigger(row: RuntimeRow, sessionName?: string | null) {
  const spec = row.scheduleSpec as unknown as GitTriggerSpec;
  const base = serializeSessionReminder(row);
  const target = triggerTargetOf(spec);
  return {
    ...base,
    origin: 'runtime' as const,
    agent: spec.agent,
    source: sourceFields(row.projectId, spec),
    target: target.kind === 'session' ? { ...target, session_name: sessionName ?? null } : target,
  };
}

/** One `GET /triggers/all` row for a kortix.yaml trigger, from its `GET /triggers` shape. */
export function serializeDeclaredTrigger(projectId: string, trigger: TriggerList['triggers'][number]) {
  const spec = {
    slug: trigger.slug,
    type: trigger.type as GitTriggerType,
    cron: trigger.cron,
    runAt: trigger.run_at,
    timezone: trigger.timezone,
    everySeconds: trigger.every_seconds ?? undefined,
    secretEnv: trigger.secret_env,
    event: trigger.event ? { connector: trigger.event.connector, account: trigger.event.account, type: trigger.event.type, config: {} } : null,
    app: trigger.app,
    // A kortix.yaml change_request trigger lists its branch as `filter.base` (`GET /triggers`).
    changeRequest: { crId: null, base: typeof trigger.filter?.base === 'string' ? trigger.filter.base : null },
  };
  return {
    id: trigger.slug,
    origin: 'declared' as const,
    path: trigger.path,
    name: trigger.name === trigger.slug ? null : trigger.name,
    prompt: trigger.prompt_template,
    agent: trigger.agent,
    enabled: trigger.enabled,
    state: trigger.enabled && !trigger.auto_paused_at ? ('active' as const) : ('paused' as const),
    source: sourceFields(projectId, spec),
    target: trigger.target?.app ? { kind: 'app' as const, app: trigger.target.app } : { kind: 'agent' as const, agent: trigger.agent },
    next_fire_at: trigger.next_fire_at ?? null,
    last_fired_at: trigger.last_fired_at,
    last_status: trigger.last_status,
    last_error: trigger.last_error,
  };
}

const notSessionTarget = sql`${projectTriggerRuntime.scheduleSpec} ->> 'reminder' is null`;

/** Runtime rows that start an agent session (session-target rows are listed with the loops). */
export async function listRuntimeAgentTriggers(projectId: string): Promise<RuntimeRow[]> {
  return db
    .select()
    .from(projectTriggerRuntime)
    .where(and(eq(projectTriggerRuntime.projectId, projectId), or(like(projectTriggerRuntime.slug, `${RUNTIME_TRIGGER_ID_PREFIX}%`), like(projectTriggerRuntime.slug, `${LEGACY_RUNTIME_TRIGGER_ID_PREFIX}%`)), notSessionTarget))
    .orderBy(asc(projectTriggerRuntime.slug))
    // ponytail: one page of 200, like the loop list; add a cursor when a project holds more.
    .limit(200);
}

export async function loadRuntimeTrigger(projectId: string, slug: string): Promise<RuntimeRow | null> {
  if (!isRuntimeTriggerSlug(slug)) return null;
  const [row] = await db
    .select()
    .from(projectTriggerRuntime)
    .where(and(eq(projectTriggerRuntime.projectId, projectId), eq(projectTriggerRuntime.slug, slug)))
    .limit(1);
  return row?.scheduleSpec ? row : null;
}

/**
 * The webhook receiver's lookup for a runtime id: the stored spec of an
 * enabled runtime webhook trigger. `enabled` lives on the row (pause flips it),
 * so it overrides the spec's own flag.
 */
export async function runtimeWebhookSpec(projectId: string, slug: string): Promise<GitTriggerSpec | null> {
  const row = await loadRuntimeTrigger(projectId, slug);
  if (!row || row.triggerType !== 'webhook') return null;
  return { ...(row.scheduleSpec as unknown as GitTriggerSpec), enabled: row.enabled !== false };
}

/** Store an agent-target runtime trigger. A schedule gets its first slot now. */
export async function insertRuntimeAgentTrigger(input: {
  projectId: string;
  spec: GitTriggerSpec;
  createdBy: string;
  firstFireAt: Date | null;
  now: Date;
}): Promise<RuntimeRow> {
  const { spec } = input;
  const [row] = await db
    .insert(projectTriggerRuntime)
    .values({
      projectId: input.projectId,
      slug: spec.slug,
      ownerUserId: input.createdBy,
      triggerType: spec.type,
      enabled: true,
      scheduleCron: spec.cron,
      scheduleRunAt: spec.runAt ? new Date(spec.runAt) : null,
      scheduleTimezone: spec.timezone,
      scheduleRevision: triggerScheduleRevision(spec),
      scheduleSpec: spec as unknown as Record<string, unknown>,
      nextFireAt: input.firstFireAt,
      updatedAt: input.now,
    })
    .returning();
  return row!;
}

export async function deleteRuntimeTrigger(projectId: string, slug: string): Promise<void> {
  await db
    .delete(projectTriggerRuntime)
    // A runtime id only: a kortix.yaml trigger's row is the manifest's, and reconcile owns it.
    .where(and(eq(projectTriggerRuntime.projectId, projectId), eq(projectTriggerRuntime.slug, slug), like(projectTriggerRuntime.slug, '%.%')));
}
