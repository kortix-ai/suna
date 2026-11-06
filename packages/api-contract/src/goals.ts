/**
 * Goals: `/v1/projects/:projectId/goals/*` (project flag `goals`).
 *
 * A goal is what a person wants plus a definition of done. An assigned agent
 * works it in an owner session until an independent verifier session passes
 * every criterion. The API owns the lifecycle: the `project_goals` row is the
 * authority for state, pause, stop, owner, verifier, caps and counters. The
 * goal's Drive folder (`GOAL.md` brief, `log.md`, `evidence/`) holds the
 * human-readable brief and the artifacts; lifecycle fields written into
 * `GOAL.md` front matter change nothing.
 *
 * Who may call what (the API derives the actor; a body never names it):
 * - a person (user credential: JWT / PAT): create, edit, pause, resume, stop,
 *   restart, answer, edit criteria;
 * - the goal's current owner session (agent session credential): set criteria
 *   while draft, activate, wait, report progress, request verification, hand
 *   over;
 * - the goal's current verifier session: give the verdict.
 * Anything else answers `403 goal_forbidden`. A lifecycle write carries the
 * `revision` it read; a stale one answers `409 goal_conflict` with the
 * current goal.
 */
import { z } from 'zod';

export const GOAL_LIMITS = {
  title_chars: 200,
  brief_chars: 20_000,
  criteria_min: 1,
  criteria_max: 8,
  criterion_chars: 500,
  reason_chars: 2_000,
  answer_chars: 10_000,
  /** Default and bounds of the heartbeat while `active`. */
  heartbeat_default: '4h',
  heartbeat_min_minutes: 5,
  /** Default and hard bounds of the server-enforced caps. */
  max_wakes_per_day_default: 12,
  max_wakes_per_day_hard: 48,
  max_sessions_default: 10,
  max_sessions_hard: 50,
  /** A `wait` may ask to be woken to chase at most this far ahead. */
  chase_min_minutes: 60,
  chase_max_days: 14,
  /** Verification that runs longer than this is stalled (health). */
  verification_stalled_hours: 24,
} as const;

export const GoalStateSchema = z.enum(['draft', 'active', 'waiting_on_user', 'verifying', 'done', 'stopped']);
export type GoalState = z.infer<typeof GoalStateSchema>;
export const GOAL_OPEN_STATES: readonly GoalState[] = ['draft', 'active', 'waiting_on_user', 'verifying'];

/**
 * Why a goal cannot make progress by itself right now. Null: nothing blocks it.
 * - `credits`: a wake was refused for credits; it resumes after a top-up and a person's resume.
 * - `wake_cap`: max_wakes_per_day reached; it resumes the next UTC day by itself.
 * - `session_cap`: max_sessions reached; a person raises the cap.
 * - `owner_lost`: the owner session failed and no successor took over; a person restarts it.
 * - `storage`: the goal's Drive folder could not be read or written.
 * - `flag_off`: the project's `goals` flag is off; nothing runs until it is on and a person resumes.
 * - `setup`: create did not finish; the API finishes it by itself.
 */
export const GoalBlockedReasonSchema = z.enum(['credits', 'wake_cap', 'session_cap', 'owner_lost', 'storage', 'flag_off', 'setup']);
export type GoalBlockedReason = z.infer<typeof GoalBlockedReasonSchema>;

export const GoalCriterionSchema = z.object({
  id: z.string(),
  text: z.string(),
  /** The owner's claim. Not verification: see `verified`. */
  reported_met: z.boolean(),
  /** A path relative to the goal folder, under `evidence/`. */
  evidence: z.string().nullable(),
  /** Set only by a passed verification of the current `criteria_revision`. */
  verified: z.boolean(),
});
export type GoalCriterion = z.infer<typeof GoalCriterionSchema>;

export const GoalCriterionResultSchema = z.object({
  criterion_id: z.string(),
  result: z.enum(['pass', 'fail', 'inconclusive']),
  note: z.string().max(GOAL_LIMITS.reason_chars),
});
export type GoalCriterionResult = z.infer<typeof GoalCriterionResultSchema>;

export const GoalVerificationSchema = z.object({
  attempt: z.number().int(),
  verifier_session_id: z.string(),
  criteria_revision: z.number().int(),
  started_at: z.string(),
  decided_at: z.string().nullable(),
  outcome: z.enum(['pending', 'pass', 'fail']),
  results: z.array(GoalCriterionResultSchema),
  /** Evidence files the verdict covered: path → sha256 of the bytes at verdict time. */
  evidence_hashes: z.record(z.string(), z.string()),
});
export type GoalVerification = z.infer<typeof GoalVerificationSchema>;

/** What the caller may do on this goal now. The UI shows only these controls. */
export const GoalCapabilitiesSchema = z.object({
  read: z.boolean(),
  edit: z.boolean(),
  pause: z.boolean(),
  resume: z.boolean(),
  stop: z.boolean(),
  restart: z.boolean(),
  answer: z.boolean(),
  edit_criteria: z.boolean(),
});
export type GoalCapabilities = z.infer<typeof GoalCapabilitiesSchema>;

export const GoalSchema = z.object({
  goal_id: z.string(),
  project_id: z.string(),
  /** Compare-and-set token: send it back on every lifecycle write. */
  revision: z.number().int(),
  title: z.string(),
  state: GoalStateSchema,
  /** The question the goal waits on while `waiting_on_user`. */
  waiting_on: z.string().nullable(),
  /** When a `waiting_on_user` goal wakes to chase, if it asked to. */
  chase_at: z.string().nullable(),
  summary: z.string(),
  paused_at: z.string().nullable(),
  paused_by_user_id: z.string().nullable(),
  stopped_at: z.string().nullable(),
  blocked_reason: GoalBlockedReasonSchema.nullable(),
  assigned_user_id: z.string().nullable(),
  created_by_user_id: z.string(),
  agent: z.string().nullable(),
  space: z.string().nullable(),
  drive_id: z.string(),
  /** The folder in Files, for example `/Users/<user_id>/Goals/<slug>`. */
  folder: z.string(),
  /** The same folder as the owner's sandbox sees it, for example `/drives/me/Goals/<slug>`. */
  box_folder: z.string(),
  slug: z.string(),
  owner_session_id: z.string().nullable(),
  /** Every owner and verifier session the goal used, oldest first. */
  sessions: z.array(z.object({ id: z.string(), role: z.enum(['owner', 'verifier']), since: z.string() })),
  criteria_revision: z.number().int(),
  criteria: z.array(GoalCriterionSchema),
  verification: GoalVerificationSchema.nullable(),
  heartbeat_every: z.string(),
  next_wake_at: z.string().nullable(),
  last_wake_at: z.string().nullable(),
  max_wakes_per_day: z.number().int(),
  wakes_today: z.number().int(),
  max_sessions: z.number().int(),
  /** `legacy_unverified`: imported from a folder; a `done` there was never verified by the API. */
  provenance: z.enum(['api', 'legacy_unverified']),
  created_at: z.string(),
  updated_at: z.string(),
  capabilities: GoalCapabilitiesSchema,
});
export type Goal = z.infer<typeof GoalSchema>;

export const GoalEventSchema = z.object({
  id: z.string(),
  goal_id: z.string(),
  at: z.string(),
  /** For example `created`, `activated`, `waiting`, `answered`, `paused`, `resumed`, `stopped`, `restarted`, `wake_admitted`, `wake_refused`, `verification_requested`, `verdict`, `handover`, `owner_adopted`, `criteria_changed`, `progress`, `blocked`, `unblocked`, `edited`. */
  kind: z.string(),
  actor_kind: z.enum(['user', 'session', 'platform']),
  actor_id: z.string().nullable(),
  from_state: GoalStateSchema.nullable(),
  to_state: GoalStateSchema.nullable(),
  /** A short human-readable line; never a secret. */
  message: z.string(),
  data: z.record(z.string(), z.unknown()),
});
export type GoalEvent = z.infer<typeof GoalEventSchema>;

export const GoalListResponseSchema = z.object({ goals: z.array(GoalSchema) });
export const GoalResponseSchema = z.object({ goal: GoalSchema });
export const GoalEventsResponseSchema = z.object({ events: z.array(GoalEventSchema), next_cursor: z.string().nullable() });

/** `409 goal_conflict` and `403 goal_forbidden` / `422 goal_invalid` bodies. */
export const GoalErrorSchema = z.object({
  error: z.enum(['goal_conflict', 'goal_forbidden', 'goal_invalid', 'goal_not_found', 'goal_flag_off']),
  message: z.string(),
  /** Each reason the move was refused, one sentence each. */
  violations: z.array(z.string()).optional(),
  /** On `goal_conflict`: the goal as it is now. */
  goal: GoalSchema.optional(),
});
export type GoalError = z.infer<typeof GoalErrorSchema>;

// ── Requests ────────────────────────────────────────────────────────────────

/** `POST /goals` — a person. `goal_id` is the idempotency key: a retry with the same id returns the same goal. */
export const CreateGoalRequestSchema = z.object({
  goal_id: z.uuid(),
  /** First line = title; the rest = context in GOAL.md. */
  brief: z.string().min(1).max(GOAL_LIMITS.brief_chars),
  criteria: z.array(z.string().min(1).max(GOAL_LIMITS.criterion_chars)).max(GOAL_LIMITS.criteria_max).optional(),
  agent: z.string().optional(),
  assigned_user_id: z.string().optional(),
});
export type CreateGoalRequest = z.infer<typeof CreateGoalRequestSchema>;

/** `PATCH /goals/:id` — a person. */
export const EditGoalRequestSchema = z.object({
  revision: z.number().int(),
  title: z.string().min(1).max(GOAL_LIMITS.title_chars).optional(),
  assigned_user_id: z.string().nullable().optional(),
  space: z.string().nullable().optional(),
  agent: z.string().nullable().optional(),
  max_wakes_per_day: z.number().int().min(1).max(GOAL_LIMITS.max_wakes_per_day_hard).optional(),
  max_sessions: z.number().int().min(1).max(GOAL_LIMITS.max_sessions_hard).optional(),
  heartbeat_every: z.string().optional(),
});
export type EditGoalRequest = z.infer<typeof EditGoalRequestSchema>;

/** `POST /goals/:id/{pause,resume,stop,restart}` — a person. */
export const GoalControlRequestSchema = z.object({
  revision: z.number().int(),
  reason: z.string().max(GOAL_LIMITS.reason_chars).optional(),
});
export type GoalControlRequest = z.infer<typeof GoalControlRequestSchema>;

/** `POST /goals/:id/answer` — the assigned user or a project admin, while `waiting_on_user` (or any open state). */
export const AnswerGoalRequestSchema = z.object({
  /** Idempotency key: a retry with the same id queues nothing twice. */
  answer_id: z.uuid(),
  text: z.string().min(1).max(GOAL_LIMITS.answer_chars),
});
export type AnswerGoalRequest = z.infer<typeof AnswerGoalRequestSchema>;

/** `PUT /goals/:id/criteria` — a person (bumps `criteria_revision`), or the owner session while `draft`. */
export const SetGoalCriteriaRequestSchema = z.object({
  revision: z.number().int(),
  criteria: z.array(z.string().min(1).max(GOAL_LIMITS.criterion_chars)).min(GOAL_LIMITS.criteria_min).max(GOAL_LIMITS.criteria_max),
});
export type SetGoalCriteriaRequest = z.infer<typeof SetGoalCriteriaRequestSchema>;

/** `POST /goals/:id/activate` — the owner session: draft → active (needs 1–8 criteria). */
export const ActivateGoalRequestSchema = z.object({ revision: z.number().int(), reason: z.string().min(1).max(GOAL_LIMITS.reason_chars) });

/** `POST /goals/:id/wait` — the owner session: active → waiting_on_user. No model turn runs until the answer, or `chase_at`. */
export const WaitGoalRequestSchema = z.object({
  revision: z.number().int(),
  question: z.string().min(1).max(GOAL_LIMITS.reason_chars),
  chase_at: z.string().optional(),
});

/** `POST /goals/:id/progress` — the owner session: report criteria and summary. Reports only; never verifies. */
export const GoalProgressRequestSchema = z.object({
  revision: z.number().int(),
  summary: z.string().max(GOAL_LIMITS.reason_chars).optional(),
  criteria: z
    .array(z.object({ id: z.string(), reported_met: z.boolean(), evidence: z.string().nullable().optional() }))
    .optional(),
});

/** `POST /goals/:id/request-verification` — the owner session: every criterion reported met with an evidence file. */
export const RequestVerificationRequestSchema = z.object({ revision: z.number().int() });

/** `POST /goals/:id/verdict` — the current verifier session: exactly one result per current criterion. */
export const GoalVerdictRequestSchema = z.object({
  revision: z.number().int(),
  results: z.array(GoalCriterionResultSchema).min(1).max(GOAL_LIMITS.criteria_max),
});

/** `POST /goals/:id/handover` — the owner session: a fresh owner session takes over. */
export const HandoverGoalRequestSchema = z.object({ revision: z.number().int(), note: z.string().min(1).max(GOAL_LIMITS.answer_chars) });
