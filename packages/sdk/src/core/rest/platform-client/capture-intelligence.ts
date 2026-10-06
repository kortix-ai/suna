// Kortix Capture Intelligence: what the recordings of an account mean.
//
//   L1 episodes   one task of one person on one device (start, end, goal, outcome)
//   L2 steps      an episode as ordered, normalized steps; literal values become variables
//   L3 workflows  procedures people repeat, with variants, decision points and stats;
//                 status detected → reviewed → exported
//   L4 skills     a workflow drafted as a SKILL.md and published into a project
//   L5 ask        questions answered with citations to workflows, episodes and moments
//
// Every call is account-scoped (Capture's tenant). Overview, workflows and
// exports need a Capture admin or viewer (writes: admin). Episodes and Ask
// default to your own data; an admin or viewer may widen them (audited).

import { backendApi } from '../../http/api-client';
import { unwrap } from '../projects-client/shared';

export type CaptureWorkflowStatus = 'detected' | 'reviewed' | 'exported';

export interface CaptureWorkflowSummary {
  workflow_id: string;
  name: string;
  goal: string | null;
  status: CaptureWorkflowStatus;
  runs_total: number;
  runs_per_week: number;
  /** Typical (p50) and slow (p90) duration of one run, in seconds. */
  duration_p50_s: number;
  duration_p90_s: number;
  people_count: number;
  apps: string[];
  steps_count: number;
  variants_count: number;
  /** Share of runs that reached the outcome, 0–1; null while unknown. */
  success_rate: number | null;
  /** How alike the runs' steps are, 0–1. */
  determinism: number;
  /** runs/week × typical duration × determinism. */
  automation_hours_per_week: number;
  first_seen_at: string | null;
  last_seen_at: string | null;
  updated_at: string;
}

/** One step of the canonical procedure. `variables` name the values a run fills in (`{order_id}`). */
export interface CaptureWorkflowStep {
  index: number;
  verb: string;
  object: string;
  app: string | null;
  /** Where in the app, e.g. `Orders › Search · exact match`. */
  params?: string | null;
  variables?: string[];
  /** A decision taken after this step: which variant a "yes" leads to, and how often. */
  decision?: { question: string; variant: string; share: number } | null;
}

export interface CaptureWorkflowVariant {
  /** `A` is the canonical path. */
  key: string;
  name: string;
  runs: number;
  /** Share of runs, 0–1. */
  share: number;
  steps_count: number;
  /** 1-based indexes of the steps that differ from the canonical path. */
  differs: number[];
  note: string;
  /** The decision that leads to this variant, as a condition ("the order is older than 30 days"); absent on A. */
  question?: string;
}

export interface CaptureWorkflowDetail extends CaptureWorkflowSummary {
  outcome: string | null;
  steps: CaptureWorkflowStep[];
  variants: CaptureWorkflowVariant[];
  /** Who runs it: runs and typical duration per person. */
  people: { user_id: string; runs: number; duration_p50_s: number }[];
  reviewed_by: string | null;
  reviewed_at: string | null;
  /** The published skill, once exported. */
  skill: { project_id: string; path: string; name: string; exported_at: string; exported_by: string } | null;
  model: string | null;
  cost_usd: number;
}

export interface CaptureWorkflowQuery {
  status?: CaptureWorkflowStatus;
  /** Matches the name, goal and steps. */
  q?: string;
  app?: string;
  /** Workflows this member ran. */
  userId?: string;
  /** `hours` (default): automatable hours a week; `runs`: runs a week; `newest`: first seen. */
  sort?: 'hours' | 'runs' | 'newest';
  limit?: number;
  offset?: number;
}

export interface CaptureWorkflowList {
  workflows: CaptureWorkflowSummary[];
  counts: { all: number; detected: number; reviewed: number; exported: number };
}

export interface CaptureWorkflowReview {
  name?: string;
  goal?: string;
  outcome?: string;
  steps?: CaptureWorkflowStep[];
}

export interface CaptureSkillDraft {
  /** The skill's name: lower case, a–z, 0–9 and dashes. */
  name: string;
  markdown: string;
  inputs: string[];
  /** The workflow version this draft reads (its `updated_at`): re-draft when the workflow moves past it. */
  workflow_updated_at: string;
  /** What to check before publishing, e.g. every variant covered, no literal customer values. */
  checks: { ok: boolean; label: string }[];
}

export interface CaptureSkillExportInput {
  /** The project of the account to publish into (`skills/<name>/SKILL.md` on its default branch). */
  project_id: string;
  name: string;
  markdown: string;
}

export interface CaptureSkillExported {
  workflow_id: string;
  status: 'exported';
  skill: { project_id: string; path: string; name: string; exported_at: string; exported_by: string };
}

export interface CaptureOverview {
  from: string;
  to: string;
  people: { total: number; recording: number };
  devices: { total: number; online: number; needs_permission: number };
  hours_recorded: number;
  /** The same length of time just before `from`. */
  hours_recorded_previous: number;
  workflows: { total: number; detected: number; reviewed: number; exported: number };
  automation_hours_per_week: number;
  top_opportunities: CaptureWorkflowSummary[];
  new_this_week: CaptureWorkflowSummary[];
  /** Automatable hours a week as of the end of each of the last 12 weeks. */
  trend: { week_start: string; automation_hours_per_week: number }[];
}

export interface CaptureEpisode {
  episode_id: string;
  user_id: string;
  device_id: string | null;
  /** `saved` = a span a person pinned. */
  source: 'detected' | 'saved';
  start_at: string;
  end_at: string;
  duration_s: number;
  label: string | null;
  goal: string | null;
  outcome: string | null;
  outcome_status: 'succeeded' | 'failed' | 'abandoned' | null;
  apps: string[];
  /** `open` while it grows, `closed`, `traced` once its steps exist, `failed`. */
  status: 'open' | 'closed' | 'traced' | 'failed';
  steps_count: number;
  workflow_id: string | null;
  variant_key: string | null;
  model: string | null;
  cost_usd: number;
}

export interface CaptureEpisodeStep {
  index: number;
  ts: string;
  verb: string;
  app: string | null;
  object: string;
  params: string | null;
  /** Variable names this step reads or writes; never the literal values. */
  variables: string[];
  /** A frame to show for the step (`frame(id)`), when one exists. */
  keyframe_frame_id: string | null;
  action_id: string | null;
}

export interface CaptureEpisodeDetail extends CaptureEpisode {
  steps: CaptureEpisodeStep[];
}

export interface CaptureEpisodeQuery {
  /** Another member (admins and viewers, audited). */
  userId?: string;
  /** `account`: every member (admins and viewers, audited). */
  scope?: 'mine' | 'account';
  deviceId?: string;
  workflowId?: string;
  from?: string;
  to?: string;
  /** Keyset cursor: `next_before` of the previous page. */
  before?: string;
  limit?: number;
}

export interface CaptureEpisodeList {
  episodes: CaptureEpisode[];
  next_before: string | null;
}

export interface CaptureIntelligenceRunInput {
  /** Only re-mine workflows; skip re-tracing ranges. */
  mining_only?: boolean;
}

export interface CaptureIntelligenceRun {
  /** Closed or failed detected ranges queued for episodes (L1/L2). */
  episodes_queued: number;
  /** Mining (L3) queued; false when a run is already queued for this slot. */
  mining_queued: boolean;
}

export interface CaptureExportInput {
  format: 'jsonl' | 'parquet';
  from?: string;
  to?: string;
  include?: ('episodes' | 'steps' | 'workflows')[];
}

export interface CaptureExport {
  export_id: string;
  format: 'jsonl' | 'parquet';
  params: Record<string, unknown>;
  status: 'queued' | 'running' | 'done' | 'failed';
  rows: number | null;
  bytes: number | null;
  error: string | null;
  /** A signed URL, valid for 1 hour, once `done`. */
  download: { url: string; expires_at: string } | null;
  created_at: string;
  updated_at: string;
}

const base = (accountId: string) => `/accounts/${accountId}/capture`;

function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

/** Hours recorded, people, devices, automatable hours a week, top workflows, new this week, trend (admins, viewers). */
export async function getCaptureOverview(accountId: string, window: { from?: string; to?: string } = {}) {
  return unwrap(await backendApi.get<CaptureOverview>(`${base(accountId)}/overview${query(window)}`));
}

export async function listCaptureWorkflows(accountId: string, q: CaptureWorkflowQuery = {}) {
  return unwrap(
    await backendApi.get<CaptureWorkflowList>(
      `${base(accountId)}/workflows${query({ status: q.status, q: q.q, app: q.app, user_id: q.userId, sort: q.sort, limit: q.limit, offset: q.offset })}`,
    ),
  );
}

export async function getCaptureWorkflow(accountId: string, workflowId: string) {
  return unwrap(await backendApi.get<CaptureWorkflowDetail>(`${base(accountId)}/workflows/${workflowId}`));
}

/** Rename, restate, edit the steps; the workflow reads as reviewed (Capture admins). */
export async function reviewCaptureWorkflow(accountId: string, workflowId: string, review: CaptureWorkflowReview) {
  return unwrap(await backendApi.post<CaptureWorkflowDetail>(`${base(accountId)}/workflows/${workflowId}/review`, review));
}

/** Run the pipelines now instead of waiting for the next range close or the nightly mining (Capture admins). */
export async function runCaptureIntelligence(accountId: string, input: CaptureIntelligenceRunInput = {}) {
  return unwrap(await backendApi.post<CaptureIntelligenceRun>(`${base(accountId)}/intelligence/run`, input));
}

/** A SKILL.md drafted from the workflow, with checks to read before publishing (Capture admins). */
export async function draftCaptureSkill(accountId: string, workflowId: string, options: { name?: string } = {}) {
  return unwrap(await backendApi.post<CaptureSkillDraft>(`${base(accountId)}/workflows/${workflowId}/skill-draft`, options));
}

/** Publish the (edited) draft into a project of the account; the workflow reads as exported (Capture admins). */
export async function exportCaptureSkill(accountId: string, workflowId: string, input: CaptureSkillExportInput) {
  return unwrap(await backendApi.post<CaptureSkillExported>(`${base(accountId)}/workflows/${workflowId}/skill`, input));
}

export async function listCaptureEpisodes(accountId: string, q: CaptureEpisodeQuery = {}) {
  return unwrap(
    await backendApi.get<CaptureEpisodeList>(
      `${base(accountId)}/episodes${query({
        user_id: q.userId,
        scope: q.scope,
        device_id: q.deviceId,
        workflow_id: q.workflowId,
        from: q.from,
        to: q.to,
        before: q.before,
        limit: q.limit,
      })}`,
    ),
  );
}

export async function getCaptureEpisode(accountId: string, episodeId: string) {
  return unwrap(await backendApi.get<CaptureEpisodeDetail>(`${base(accountId)}/episodes/${episodeId}`));
}

/** Start a bulk export (Capture admins). Poll `getCaptureExport` until `done`, then download. */
export async function createCaptureExport(accountId: string, input: CaptureExportInput) {
  return unwrap(await backendApi.post<CaptureExport>(`${base(accountId)}/exports`, input));
}

export async function listCaptureExports(accountId: string) {
  return unwrap(await backendApi.get<{ exports: CaptureExport[] }>(`${base(accountId)}/exports`));
}

export async function getCaptureExport(accountId: string, exportId: string) {
  return unwrap(await backendApi.get<CaptureExport>(`${base(accountId)}/exports/${exportId}`));
}
