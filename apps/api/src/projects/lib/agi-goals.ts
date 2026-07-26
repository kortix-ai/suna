/**
 * Goals — the AGI layer's durable objective, declared in the project manifest
 * (`kortix.yaml`) as a top-level `goals:` list and applied by `kortix ship`
 * like any other manifest edit (R-6, docs/specs/2026-07-26-agi-autonomous-operations.md §4).
 *
 * Example shape (kortix.yaml):
 *
 *   kortix_version: 2
 *
 *   goals:
 *     - slug: oil-desk
 *       title: Oil trades running 24/7
 *       done_when: >
 *         A live account executes the strategy unattended for 7 consecutive
 *         days with no manual intervention and a positive risk-adjusted return.
 *       status: active          # active | achieved | paused | abandoned
 *       push: "0 0 9 * * *"     # standing advance; omit for on-demand goals
 *       agent: kortix-agi       # default; name a project agent to override
 *
 * Two requirements shape everything in this file:
 *
 *   R-7 — `done_when` is MANDATORY. A goal without prose completion criteria a
 *         session can evaluate against evidence is a wish, and is rejected.
 *
 *   R-8 — `push` is SUGAR for exactly one cron trigger in the EXISTING trigger
 *         subsystem, not a second scheduler. {@link desugarGoalTriggers} turns
 *         each pushing goal into a plain {@link GitTriggerSpec} that the sweep,
 *         the fire route, and the trigger list all consume unchanged. The
 *         derived trigger is NEVER written back to the manifest — it is
 *         re-derived on every read from a slug that is a pure function of the
 *         goal slug ({@link goalTriggerSlug}), so re-shipping the same goals
 *         cannot accumulate duplicate triggers.
 *
 * Goal STATUS is authored state and only ever changes by a human editing this
 * file (R-9) — nothing here, and nothing a session does, may mark a goal
 * `achieved`. The push prompt says so explicitly.
 *
 * Never throws: malformed entries land in `errors` with a slug + reason, the
 * same contract `extractTriggers` guarantees, so one bad goal can't blank the
 * whole list.
 */
import { AGI_AGENT_NAME } from '../agents';
import type { GitTriggerParseError, GitTriggerSpec, ParsedManifest } from '../triggers';

/** Same shape trigger slugs use — the derived trigger slug has to satisfy the
 *  trigger parser's own rule, so there is no point being laxer here. */
const GOAL_SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,127}$/;

/** Prefix that makes a derived trigger recognizable as goal sugar rather than
 *  an authored `triggers:` entry. Deliberately part of the public surface: the
 *  trigger CRUD routes need it to refuse edits to a trigger that has no
 *  manifest entry to edit. */
export const GOAL_TRIGGER_SLUG_PREFIX = 'goal-';

export type GoalStatus = 'active' | 'achieved' | 'paused' | 'abandoned';

export const GOAL_STATUSES: readonly GoalStatus[] = ['active', 'achieved', 'paused', 'abandoned'];

export interface GoalSpec {
  /** URL-safe slug — unique per project, and the stable identity the derived
   *  trigger and every task's `goal_slug` key off. */
  slug: string;
  /** Breadcrumb for the UI: `<manifest-file>#goals.<slug>`. Deliberately NOT
   *  `#triggers.<slug>` — it is what tells a reader the derived trigger came
   *  from the goals block. */
  path: string;
  /** Human label; defaults to the slug when not set. */
  title: string;
  /** R-7. Prose completion criteria. Never empty — a goal without it is an
   *  error, not a goal with a blank field. */
  doneWhen: string;
  status: GoalStatus;
  /** 6-field croner expression for the standing advance, or null for a goal
   *  advanced only on demand. Syntax is validated by croner at fire time, the
   *  same as an authored cron trigger's. */
  push: string | null;
  /** Agent that advances the goal. Defaults to the platform AGI
   *  ({@link AGI_AGENT_NAME}) — see {@link parseGoalEntry}. */
  agent: string;
  /** IANA timezone the `push` expression is evaluated in. Defaults to UTC. */
  timezone: string;
  /** Slug of the cron trigger `push` desugars to, or null when there is no
   *  push. Pure function of {@link slug} — see {@link goalTriggerSlug}. */
  triggerSlug: string | null;
}

export interface GoalParseError {
  slug: string;
  path: string;
  error: string;
}

export interface LoadedGoals {
  specs: GoalSpec[];
  errors: GoalParseError[];
}

/**
 * The trigger slug a goal's `push` desugars to. Deterministic and total: the
 * same goal slug always yields the same trigger slug, which is what makes
 * re-shipping idempotent (the derived trigger is matched by slug against the
 * previous read, never appended).
 */
export function goalTriggerSlug(goalSlug: string): string {
  return `${GOAL_TRIGGER_SLUG_PREFIX}${goalSlug}`;
}

/** Whether a trigger slug belongs to a goal's desugared push. */
export function isGoalTriggerSlug(slug: string): boolean {
  return slug.startsWith(GOAL_TRIGGER_SLUG_PREFIX);
}

// A bad IANA timezone (a typo, or an abbreviation like "PST") would otherwise
// only fail inside the cron due-check, where it is swallowed to `false` and the
// push silently never fires. Local copy of the identical guard in ../triggers:
// importing it would close a runtime import cycle for one three-line predicate
// (the type imports above are erased).
function isValidTimeZone(tz: string): boolean {
  if (tz === 'UTC') return true;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * The prompt the desugared push trigger carries. Encodes R-11's ordering (read
 * the goal and its criteria → read open tasks → pick the single most valuable
 * next move → take it or create the tasks that constitute it → record what
 * changed), R-12's "advanced or say why not", and R-9's prohibition on the
 * session declaring the goal achieved.
 *
 * Pure and deterministic: the same goal always renders the same prompt, so a
 * re-ship produces a byte-identical trigger.
 */
export function goalPushPrompt(goal: Pick<GoalSpec, 'slug' | 'title' | 'doneWhen'>): string {
  return [
    `Advance the goal "${goal.title}" (slug: ${goal.slug}).`,
    '',
    'Done when:',
    goal.doneWhen.trim(),
    '',
    `In this order: re-read this goal and its completion criteria; read the open tasks for goal "${goal.slug}"; decide the single most valuable next move; take it, or create the tasks that constitute it; then record what changed.`,
    '',
    'Leave the goal measurably advanced, or state why you could not — "reviewed, nothing to do" is only a valid outcome with a stated reason.',
    '',
    'Do not mark the goal achieved. Goal status is authored state in kortix.yaml and changes only by an explicit human act with cited evidence.',
  ].join('\n');
}

/**
 * Build the single cron trigger a goal's `push` desugars to (R-8), or null when
 * the goal declares no push.
 *
 * A non-`active` goal still yields the trigger, DISABLED — the sweep skips it,
 * but it stays visible in the trigger list so pausing a goal reads as "this
 * stopped" rather than "this vanished".
 *
 * `agent` is passed through verbatim, which is the whole trick: a trigger targets
 * an agent BY NAME, and {@link AGI_AGENT_NAME} is a name the grant resolver
 * answers without a manifest entry. Before that reserved path existed, a goal
 * naming the AGI desugared into a trigger whose session booted with an empty
 * `kortix_cli` grant and 403'd on every `kortix` call — the scheduled push
 * structurally could not run the agent whose loop it encodes.
 */
export function goalTriggerSpec(goal: GoalSpec, filename: string): GitTriggerSpec | null {
  if (!goal.push || !goal.triggerSlug) return null;
  return {
    slug: goal.triggerSlug,
    path: `${filename}#goals.${goal.slug}`,
    name: goal.title,
    type: 'cron',
    agent: goal.agent,
    model: null,
    enabled: goal.status === 'active',
    promptTemplate: goalPushPrompt(goal),
    cron: goal.push,
    runAt: null,
    timezone: goal.timezone,
    secretEnv: null,
    // A standing advance is one long-running line of work on one objective, so
    // every fire re-prompts the SAME session rather than minting a fresh one —
    // the goal's history is the context the next push needs most.
    sessionMode: 'reuse',
    pinnedSessionId: null,
    sessionKey: null,
    filter: null,
  };
}

/**
 * Parse the `goals:` list out of a loaded manifest. Never throws — bad entries
 * land in `errors` with a slug + reason so the UI can render them alongside the
 * good ones.
 *
 * Goals are returned in MANIFEST DECLARATION ORDER (unlike triggers, which sort
 * by slug): the author's ordering is the priority ordering a human reads the
 * file for, and there are single digits of them (R-10).
 */
export function extractGoals(manifest: ParsedManifest): LoadedGoals {
  const filename = manifest.path || 'kortix.yaml';
  const rawGoals = manifest.raw.goals;
  if (rawGoals === undefined || rawGoals === null) {
    return { specs: [], errors: [] };
  }
  if (!Array.isArray(rawGoals)) {
    return {
      specs: [],
      errors: [
        {
          slug: '(top-level)',
          path: filename,
          error:
            manifest.format === 'yaml'
              ? '`goals` must be a list — write it as a YAML `goals:` list, not a map or scalar.'
              : '`goals` must be an array of tables — use [[goals]], not [goals]',
        },
      ],
    };
  }

  const specs: GoalSpec[] = [];
  const errors: GoalParseError[] = [];
  const seenSlugs = new Set<string>();

  rawGoals.forEach((entry, index) => {
    const result = parseGoalEntry(entry, index, filename);
    if (!result.ok) {
      errors.push(result.error);
      return;
    }
    if (seenSlugs.has(result.spec.slug)) {
      errors.push({
        slug: result.spec.slug,
        path: result.spec.path,
        error: `Duplicate goal slug "${result.spec.slug}" — slugs must be unique within a project`,
      });
      return;
    }
    seenSlugs.add(result.spec.slug);
    specs.push(result.spec);
  });

  return { specs, errors };
}

/**
 * R-8, the whole point of this module: turn every pushing goal into exactly one
 * cron trigger for the EXISTING trigger subsystem.
 *
 * `reservedSlugs` is the set of slugs already claimed by authored `triggers:`
 * entries. A collision is reported and the derived trigger is DROPPED rather
 * than shadowing or duplicating what the human wrote — the manifest is the
 * source of truth and a hand-written `goal-x` trigger wins.
 *
 * Never writes to the manifest. Re-deriving on every read is what makes a
 * re-ship idempotent by construction: there is no accumulation path.
 */
export function desugarGoalTriggers(
  manifest: ParsedManifest,
  reservedSlugs: ReadonlySet<string> = new Set(),
): { specs: GitTriggerSpec[]; errors: GitTriggerParseError[] } {
  const filename = manifest.path || 'kortix.yaml';
  const { specs: goals } = extractGoals(manifest);
  const specs: GitTriggerSpec[] = [];
  const errors: GitTriggerParseError[] = [];

  for (const goal of goals) {
    const spec = goalTriggerSpec(goal, filename);
    if (!spec) continue;
    if (reservedSlugs.has(spec.slug)) {
      errors.push({
        slug: spec.slug,
        path: spec.path,
        error: `Goal "${goal.slug}" desugars to trigger "${spec.slug}", which is already declared in \`triggers\` — rename the goal or the trigger`,
      });
      continue;
    }
    specs.push(spec);
  }

  return { specs, errors };
}

interface GoalParseOk {
  ok: true;
  spec: GoalSpec;
}
interface GoalParseErr {
  ok: false;
  error: GoalParseError;
}

function parseGoalEntry(
  entry: unknown,
  index: number,
  filename: string,
): GoalParseOk | GoalParseErr {
  const err = (slug: string, message: string): GoalParseErr => ({
    ok: false,
    error: { slug, path: `${filename}#goals.${slug}`, error: message },
  });

  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return err('(invalid)', `goals entry #${index + 1} is not a table`);
  }
  const row = entry as Record<string, unknown>;

  const slug = typeof row.slug === 'string' ? row.slug.trim() : '';
  if (!slug) return err(`(index-${index})`, `goals entry #${index + 1} is missing a slug`);
  if (!GOAL_SLUG_RE.test(slug)) {
    return err(
      slug,
      `Invalid slug "${slug}" — lowercase letters, digits, dashes, underscores only`,
    );
  }

  // R-7. The one field that separates a goal from a wish.
  const doneWhen =
    typeof row.done_when === 'string'
      ? row.done_when
      : typeof row.doneWhen === 'string'
        ? row.doneWhen
        : '';
  if (!doneWhen.trim()) {
    return err(
      slug,
      `Goal "${slug}" is missing \`done_when\` — every goal must state, in prose, the evidence that would make it achieved. A goal without done_when is a wish.`,
    );
  }

  const title = typeof row.title === 'string' && row.title.trim() ? row.title.trim() : slug;

  const statusRaw = typeof row.status === 'string' ? row.status.trim().toLowerCase() : '';
  if (statusRaw && !(GOAL_STATUSES as readonly string[]).includes(statusRaw)) {
    return err(
      slug,
      `status must be one of ${GOAL_STATUSES.map((s) => `"${s}"`).join(', ')} (got "${statusRaw}")`,
    );
  }
  const status = (statusRaw || 'active') as GoalStatus;

  // The push prompt below IS the AGI's loop (R-11/R-12), and R-38 makes the AGI
  // the thing that advances goals — so an unqualified goal is advanced by the
  // platform AGI, not by whatever general-purpose agent the project happens to
  // default to. The AGI is nameable here without a manifest entry because it
  // resolves through the reserved-name path in ../agents.ts (R-35); a goal that
  // wants a specific project agent still names it and is unaffected.
  const agent =
    typeof row.agent === 'string' && row.agent.trim() ? row.agent.trim() : AGI_AGENT_NAME;

  const timezone =
    typeof row.timezone === 'string' && row.timezone.trim() ? row.timezone.trim() : 'UTC';
  if (!isValidTimeZone(timezone)) {
    return err(
      slug,
      `timezone must be a valid IANA name like "UTC" or "America/New_York" (got "${timezone}")`,
    );
  }

  let push: string | null = null;
  if (row.push !== undefined && row.push !== null) {
    if (typeof row.push !== 'string' || !row.push.trim()) {
      return err(slug, '`push` must be a cron expression string — omit it for an on-demand goal');
    }
    push = row.push.trim();
  }

  // The derived slug has to survive the trigger parser's own slug rule, and the
  // only way it can fail is length — catch it here, where the message can name
  // the goal, instead of at the trigger layer where it would read as a mystery.
  const triggerSlug = push ? goalTriggerSlug(slug) : null;
  if (triggerSlug && !GOAL_SLUG_RE.test(triggerSlug)) {
    return err(
      slug,
      `Goal slug "${slug}" is too long — its \`push\` trigger slug would exceed 128 characters`,
    );
  }

  return {
    ok: true,
    spec: {
      slug,
      path: `${filename}#goals.${slug}`,
      title,
      doneWhen: doneWhen.trim(),
      status,
      push,
      agent,
      timezone,
      triggerSlug,
    },
  };
}
