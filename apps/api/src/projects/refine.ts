/**
 * Kortix mid-session refinement DSL — the `refine:` block of the project
 * manifest (kortix.yaml). Continual-harness cadence: every `every_turns`
 * assistant turns (after `warmup_turns`), the platform delivers a refinement
 * prompt into each eligible RUNNING session. The agent then runs the
 * four-pass protocol from the `kortix-harness-refinement` managed skill over
 * its own recent turns, applies harness edits in place on the session branch,
 * and keeps one `harness: …` change request updated toward main.
 *
 * Example shape (kortix.yaml):
 *
 *   refine:
 *     enabled: true
 *     every_turns: 25
 *     warmup_turns: 10
 *     max_per_session_per_day: 6
 *     agents: [kortix]
 *
 * The manifest is THE source of truth for refine config; per-session runtime
 * state (turn watermark, daily fire count) lives in
 * `project_sessions.metadata.refine`. The sweep lives in lib/refine-sweep.ts.
 */

import type { ParsedManifest } from './triggers';

export const REFINE_DEFAULT_EVERY_TURNS = 25;
export const REFINE_DEFAULT_WARMUP_TURNS = 10;
export const REFINE_DEFAULT_MAX_PER_SESSION_PER_DAY = 6;

/** Agents that must never receive refinement prompts: refining the refiner
 *  (or the memory curator) recurses the loop instead of improving the task
 *  agent. Sessions running these agents are always skipped by the sweep. */
export const REFINE_EXCLUDED_AGENTS: readonly string[] = ['harness-reflector', 'memory-reflector'];

export interface RefineSpec {
  enabled: boolean;
  /** F — deliver a refinement prompt every N completed assistant turns. */
  everyTurns: number;
  /** W — never before the session's first N assistant turns. */
  warmupTurns: number;
  /** Hard cap on refinement prompts per session per UTC day. */
  maxPerSessionPerDay: number;
  /**
   * Agent allowlist — only sessions running one of these agents are refined.
   * Defaults to `[default_agent]` (the manifest's declared default, falling
   * back to `kortix`), so specialists and reflectors stay untouched unless
   * opted in explicitly.
   */
  agents: string[];
}

export interface RefineParseResult {
  /** Null when the manifest has no `refine:` block (feature off). */
  spec: RefineSpec | null;
  errors: string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readBoundedInt(
  raw: unknown,
  field: string,
  fallback: number,
  min: number,
  max: number,
  errors: string[],
): number {
  if (raw === undefined || raw === null) return fallback;
  const value = typeof raw === 'string' ? Number(raw) : raw;
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    errors.push(`refine.${field} must be an integer`);
    return fallback;
  }
  if (value < min || value > max) {
    errors.push(`refine.${field} must be between ${min} and ${max}`);
    return fallback;
  }
  return value;
}

/**
 * Parse the `refine:` block out of a loaded manifest. Never throws — bad
 * fields land in `errors` with the field named, and the spec keeps that
 * field's default so a typo degrades to defaults instead of silently
 * disabling refinement (or worse, enabling a runaway cadence).
 */
export function extractRefine(manifest: ParsedManifest): RefineParseResult {
  const raw = manifest.raw.refine;
  if (raw === undefined || raw === null) return { spec: null, errors: [] };
  if (!isPlainObject(raw)) {
    return { spec: null, errors: ['`refine` must be a map (enabled/every_turns/…)'] };
  }

  const errors: string[] = [];
  const enabled = raw.enabled === true;
  const everyTurns = readBoundedInt(
    raw.every_turns,
    'every_turns',
    REFINE_DEFAULT_EVERY_TURNS,
    1,
    10_000,
    errors,
  );
  const warmupTurns = readBoundedInt(
    raw.warmup_turns,
    'warmup_turns',
    REFINE_DEFAULT_WARMUP_TURNS,
    0,
    10_000,
    errors,
  );
  const maxPerSessionPerDay = readBoundedInt(
    raw.max_per_session_per_day,
    'max_per_session_per_day',
    REFINE_DEFAULT_MAX_PER_SESSION_PER_DAY,
    1,
    96,
    errors,
  );

  const defaultAgent =
    typeof manifest.raw.default_agent === 'string' && manifest.raw.default_agent.trim()
      ? manifest.raw.default_agent.trim()
      : 'kortix';
  let agents = [defaultAgent];
  if (raw.agents !== undefined && raw.agents !== null) {
    if (
      Array.isArray(raw.agents) &&
      raw.agents.length > 0 &&
      raw.agents.every((a) => typeof a === 'string' && a.trim())
    ) {
      agents = raw.agents.map((a) => (a as string).trim());
    } else {
      errors.push('refine.agents must be a non-empty list of agent names');
    }
  }
  const excluded = agents.filter((a) => REFINE_EXCLUDED_AGENTS.includes(a));
  if (excluded.length > 0) {
    errors.push(`refine.agents must not include reflector agents (${excluded.join(', ')})`);
    agents = agents.filter((a) => !REFINE_EXCLUDED_AGENTS.includes(a));
  }

  return {
    spec: { enabled, everyTurns, warmupTurns, maxPerSessionPerDay, agents },
    errors,
  };
}
