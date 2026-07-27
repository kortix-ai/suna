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
 *       metric: pnl_usd         # optional; the series that DEFINES this goal
 *
 * Three requirements shape everything in this file:
 *
 *   R-7 — `done_when` is MANDATORY. A goal without prose completion criteria a
 *         session can evaluate against evidence is a wish, and is rejected.
 *
 *   R-12d/R-12e — `metric:` is OPTIONAL and names the ONE series whose movement
 *         is the goal's verdict. `done_when` is prose and names no metric, so
 *         without this nothing associates a threshold with a series, and a goal
 *         tracking three numbers can have the one that matters sit dead for
 *         three weeks while the other two wander and the goal reads "measuring".
 *         Declaring it is authored state (R-2), so it belongs in this file next
 *         to the criteria it quantifies — not in the database with the readings.
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
import { normalizeMetric } from '../../agi/observations/wire';
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
  /**
   * R-12e. The ONE observation series whose movement is this goal's verdict, or
   * null when the goal declares none.
   *
   * Normalized through the SAME {@link normalizeMetric} a recorded observation
   * goes through, so a declaration compares by `===` against what
   * `kortix goals observe --metric` writes. A looser comparison would let
   * `metric: Core Position` name a primary that `core_position` can never
   * satisfy — the declaration would read as honoured and the goal would sit
   * permanently unmeasurable for a reason nobody could see.
   */
  primaryMetric: string | null;
}

/**
 * Prefix that marks a {@link GoalParseError} as advisory rather than fatal.
 *
 * There is no `severity` field: goal problems reach every surface through ONE
 * channel (`errors` → `goalIssues` → `kortix goals ls`), and a second channel
 * for warnings is a second channel to forget to render. A warning is an error
 * entry on a goal that DID parse and IS in `specs` — the message carries the
 * distinction, and the goal keeps working.
 */
export const GOAL_WARNING_PREFIX = 'Warning:';

/** Advisory, not fatal: the goal it names is in `specs` and works. */
export function isGoalWarning(error: Pick<GoalParseError, 'error'>): boolean {
  return error.error.startsWith(GOAL_WARNING_PREFIX);
}

/**
 * A `done_when` shorter than this is treated as suspect. Not a hard rule — R-7
 * only requires prose — but the shortest honest completion criteria anyone
 * writes ("An offer is signed.") clears 20 characters comfortably, and the
 * strings that do not are overwhelmingly truncations.
 */
export const GOAL_DONE_WHEN_MIN_LENGTH = 20;

export interface GoalParseError {
  /** Ordinal of the offending entry in the `goals:` list, or -1 when the problem
   *  is with the block as a whole (`goals` is not a list, the manifest never
   *  parsed). Carried from the parser, which already iterates with it: the
   *  alternative is reconstructing it downstream by matching errors back against
   *  the raw entries, which is a guess that happens to be right. A malformed
   *  entry frequently has no usable slug, so this ordinal is the only thing that
   *  makes it addressable. */
  index: number;
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
 * The measurement step is the one that makes R-12 real. Without it "measurably
 * advanced" is an adjective in a prompt string and the only thing evaluating
 * `done_when` is a model grading its own homework — the failure mode §4.2 was
 * written about, where the loop looks alive for three weeks while the metric has
 * not moved. This push IS the signal (R-12a: a signal is a trigger, never a
 * probe registry), so taking the reading is part of the push and not a separate
 * schedule.
 *
 * Pure and deterministic: the same goal always renders the same prompt, so a
 * re-ship produces a byte-identical trigger.
 */
export function goalPushPrompt(
  goal: Pick<GoalSpec, 'slug' | 'title' | 'doneWhen'> & { primaryMetric?: string | null },
): string {
  // A declared primary is the difference between "record something" and "record
  // THIS". Naming it here closes the loop the declaration opens: the verdict is
  // computed from that one series, so the push that is supposed to move it has
  // to be told which series that is — otherwise the goal reads unmeasurable
  // forever while the session dutifully records three other numbers.
  const metricInstruction = goal.primaryMetric
    ? `Record the reading with: kortix goals observe ${goal.slug} --metric ${goal.primaryMetric} --value <number>. "${goal.primaryMetric}" is the metric this goal DECLARES as its definition of progress — it is the only series the stall check reads, so a push that records anything else leaves this goal reported as UNMEASURABLE. Record other metrics too if they help, but never instead of this one. If you cannot take this reading yet, say so and make taking it the next move.`
    : `Record every reading with: kortix goals observe ${goal.slug} --metric <name> --value <number>. Use the SAME metric name every time — that series is the only evidence that this goal is moving, and a renamed metric starts an empty one. If the criteria above name a threshold you cannot measure yet, say so and make measuring it the next move; a goal nobody measures is reported as UNMEASURABLE, not as on track.`;

  return [
    `Advance the goal "${goal.title}" (slug: ${goal.slug}).`,
    '',
    'Done when:',
    goal.doneWhen.trim(),
    '',
    `In this order: re-read this goal and its completion criteria; read the open tasks for goal "${goal.slug}"; TAKE A READING of whatever the completion criteria measure and record it; decide the single most valuable next move; take it, or create the tasks that constitute it; then record what changed.`,
    '',
    metricInstruction,
    '',
    'Leave the goal measurably advanced, or state why you could not — "reviewed, nothing to do" is only a valid outcome with a stated reason.',
    '',
    'Do not mark the goal achieved. Goal status is authored state in kortix.yaml and changes only by an explicit human act with cited evidence. A reading is evidence, never authority: recording one never changes the status.',
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
          index: -1,
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
      // The SECOND declaration is the error, so the ordinal is this entry's —
      // the first one parsed cleanly and is the goal that actually exists.
      errors.push({
        index,
        slug: result.spec.slug,
        path: result.spec.path,
        error: `Duplicate goal slug "${result.spec.slug}" — slugs must be unique within a project`,
      });
      return;
    }
    seenSlugs.add(result.spec.slug);
    specs.push(result.spec);
    // Advisory, so the goal is in BOTH lists: it works, and the complaint about
    // it is visible. Pushed after the spec so a reader of `errors` sees warnings
    // in the same declaration order the goals are in.
    errors.push(...result.warnings);
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
 *
 * A goal that FAILED to parse is reported here too. It has no derived trigger to
 * appear as, so dropping its error made it invisible in every trigger surface —
 * the trigger list showed no complaint and no entry, and a goal with a typo'd
 * `done_when` silently stopped existing for anyone reading triggers. The error's
 * `path` (`<manifest>#goals.<slug>`) is what tells a reader the complaint came
 * out of the goals block rather than `triggers:`.
 */
export function desugarGoalTriggers(
  manifest: ParsedManifest,
  reservedSlugs: ReadonlySet<string> = new Set(),
): { specs: GitTriggerSpec[]; errors: GitTriggerParseError[] } {
  const filename = manifest.path || 'kortix.yaml';
  const { specs: goals, errors: goalErrors } = extractGoals(manifest);
  const specs: GitTriggerSpec[] = [];
  // `index` is deliberately dropped: GitTriggerParseError is the trigger
  // subsystem's contract and these ordinals are positions in a DIFFERENT list.
  //
  // Warnings are dropped entirely. This list answers "is this trigger broken?",
  // and a goal whose `done_when` reads thin still desugars to a perfectly good
  // cron trigger — reporting it here would put a permanent complaint next to a
  // working trigger, which is how a list of real problems stops being read.
  const errors: GitTriggerParseError[] = goalErrors
    .filter((error) => !isGoalWarning(error))
    .map((error) => ({
      slug: error.slug,
      path: error.path,
      error: error.error,
    }));

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
  /** Advisory problems on a goal that parsed. Same type as a fatal error and the
   *  same channel — see {@link GOAL_WARNING_PREFIX}. */
  warnings: GoalParseError[];
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
    error: { index, slug, path: `${filename}#goals.${slug}`, error: message },
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

  // R-12e. Optional by construction: `metric` absent leaves `primaryMetric` null
  // and the goal behaves exactly as it did before this field existed, so no
  // manifest already on disk changes meaning. Present but malformed is FATAL,
  // like a bad `status` or `timezone` — the alternative is a declaration that
  // looks honoured and silently is not, which is the class of bug this whole
  // field exists to close.
  let primaryMetric: string | null = null;
  if (row.metric !== undefined && row.metric !== null) {
    const normalized = normalizeMetric(row.metric);
    if ('error' in normalized) {
      return err(slug, `\`metric\` names the series that defines this goal — ${normalized.error}`);
    }
    primaryMetric = normalized.metric;
  } else {
    // A near-miss key is worse than no key: the goal parses, the declaration is
    // silently dropped, and the goal falls back to the any-metric rule while its
    // author believes a primary is in force.
    const misspelled = PRIMARY_METRIC_NEAR_MISSES.find((key) => row[key] !== undefined);
    if (misspelled) {
      return err(
        slug,
        `Unknown key \`${misspelled}\` — the metric that defines a goal is declared as \`metric:\`. Rename it, or the goal silently falls back to stalling on ANY flat metric.`,
      );
    }
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
      primaryMetric,
    },
    warnings: goalStringWarnings({ slug, index, filename, title, doneWhen: doneWhen.trim() }),
  };
}

/** Keys an author reaches for when they mean `metric:`. Rejected by name rather
 *  than ignored — see the call site. */
const PRIMARY_METRIC_NEAR_MISSES = [
  'primary_metric',
  'primaryMetric',
  'primary',
  'metrics',
  'metric_name',
] as const;

/**
 * The YAML `#` footgun, and its fingerprint.
 *
 * Confirmed live and completely silent: `title: ranks #1 on Google` parses to
 * `"ranks"` and `done_when: rank #1 within 90 days` parses to `"rank"`, both with
 * `errors: []`. YAML reads an unquoted `#` as the start of a comment, so
 * everything after it is discarded before this parser ever sees the value —
 * there is nothing left to detect at the point of failure.
 *
 * That truncation is not cosmetic. `done_when` is what `namesThreshold` (the
 * observations wire) reads to decide R-12d, so a truncated one can downgrade from
 * `unmeasurable` ("nobody is measuring this") to `unquantified` ("there is
 * nothing to measure, that's fine") — the worst possible direction for a silent
 * failure, because the second reads as a deliberate choice.
 *
 * Two heuristics, because the broken case is invisible and only the fingerprint
 * survives:
 *
 *   • a `#` that IS present in the parsed value was quoted or came from a block
 *     scalar, so this goal is currently fine — and one hand-edit that drops the
 *     quotes silently truncates it. Warned about so the author writes "number 1"
 *     instead of carrying a live grenade.
 *   • a `done_when` under {@link GOAL_DONE_WHEN_MIN_LENGTH} characters is what an
 *     already-truncated one looks like. It is also, independently, criteria too
 *     thin for a session to evaluate — so the warning is right either way and
 *     needs no guess about which happened.
 */
function goalStringWarnings(goal: {
  slug: string;
  index: number;
  filename: string;
  title: string;
  doneWhen: string;
}): GoalParseError[] {
  const warnings: GoalParseError[] = [];
  const warn = (message: string) =>
    warnings.push({
      index: goal.index,
      slug: goal.slug,
      path: `${goal.filename}#goals.${goal.slug}`,
      error: `${GOAL_WARNING_PREFIX} ${message}`,
    });

  for (const [field, value] of [
    ['title', goal.title],
    ['done_when', goal.doneWhen],
  ] as const) {
    if (value.includes('#')) {
      warn(
        `goal "${goal.slug}" has a "#" in \`${field}\`. It survived only because the value is quoted or a block scalar — unquoted, YAML treats "#" as a comment, so \`${field}: rank #1 in 90 days\` parses to "rank" with no error at all. Write "number 1" instead, or keep the quotes forever.`,
      );
    }
  }

  if (goal.doneWhen.length < GOAL_DONE_WHEN_MIN_LENGTH) {
    warn(
      `goal "${goal.slug}" has a \`done_when\` of only ${goal.doneWhen.length} characters ("${goal.doneWhen}") — too thin for a session to evaluate against evidence, and the usual cause is an unquoted "#" that YAML truncated the line at. A truncated \`done_when\` can silently downgrade this goal from UNMEASURABLE to UNQUANTIFIED, i.e. from "nobody is measuring this" to "there is nothing to measure". Restate the full condition, quoting any "#".`,
    );
  }

  return warnings;
}
