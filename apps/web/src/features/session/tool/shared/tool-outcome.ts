/**
 * Tool-outcome + JSON-failure parsing — pure helpers, no React.
 *
 * Extracted from `infrastructure.tsx` so the verdict logic (the predicates
 * every tool renderer shares) and the `{success:false,error}` failure
 * contract parser are testable WITHOUT loading the 1500-line React module
 * that renders them. `infrastructure.tsx` re-exports everything here so
 * existing call sites keep their imports unchanged.
 *
 * No React / DOM / framework imports allowed — type-only imports only.
 */

import type { ParsedJsonFailure } from '@/features/session/tool/shared/types';
import type { ToolPart } from '@/ui';

export type ToolOutcome = 'ok' | 'partial' | 'failed';

/** A JSON value that owns properties — i.e. a plain object, not null/array. */
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function looksLikeError(text: string): boolean {
  const t = text.trim();
  if (t.length > 500) return false;
  if (/^Error:\s/i.test(t)) return true;
  if (/^([\w._-]+Error|[\w._-]+Exception):\s/i.test(t)) return true;
  if (/Traceback \(most recent call last\)/i.test(t)) return true;
  if (/^\s*\[\s*\{[\s\S]*"message"\s*:/.test(t)) return true;
  return false;
}

/**
 * True when a completed tool's output is an error rather than a result —
 * either a plain error/traceback string or the `{success:false,error}` contract.
 * Tools whose own parser returns nothing should fall back to rendering the
 * error (via `ToolOutputFallback`) instead of a blank panel.
 */
export function isErrorOutput(output: string): boolean {
  return !!output && (looksLikeError(output) || parseJsonFailure(output) !== null);
}

/**
 * Whether a settled tool call succeeded, half-succeeded, or failed.
 *
 * Three different shapes mean "this failed", and only the first of them used to
 * reach the row's icon:
 *   - the call threw            — `state.status === 'error'`
 *   - the call RETURNED the error — completed, output is `Error: …` or the
 *     `{success:false,error}` contract
 *   - the call returned a batch  — completed, `results[]` with some or all
 *     items `success:false` (scrape_webpage over three URLs, one dead host)
 *
 * Every tool renderer hardcodes its own leading icon — `GlobeIcon` for scrape,
 * a favicon for web_fetch, a terminal for bash — and none of them read the
 * output, so shapes two and three kept drawing "web page" over a failure. This
 * is the one predicate they all share; see {@link ToolOutcomeContext}.
 *
 * A running call is `ok`: it has no verdict yet. The shimmer already says
 * "in flight", and painting a warning on unfinished work is a worse lie than
 * the one this fixes.
 */
export function partOutcome(part: Pick<ToolPart, 'state'>): ToolOutcome {
  const cached = OUTCOME_CACHE.get(part);
  // Guarded on `state`, not just on the part: the cache is only sound while the
  // thing it was computed from is the same object.
  if (cached && cached.state === part.state) return cached.outcome;

  const outcome = computeOutcome(part);
  OUTCOME_CACHE.set(part, { state: part.state, outcome });
  return outcome;
}

/**
 * The verdict, memoised per part.
 *
 * `partOutcome` is called from four places and none of them are rare: once per
 * tool row in `ToolPartRenderer`, once per part in `burstSummary`, once per part
 * in a file-chip run, and once per bare `ActivityStep`. So a burst of ten tool
 * calls asks this question twelve times — and asks it again on every SSE frame,
 * because the memos above it are invalidated by the turn's identity changing.
 *
 * Uncached, each of those calls did a full `.trim()` copy plus up to TWO
 * complete `JSON.parse` runs (see `computeOutcome`) over an output that can be
 * hundreds of kilobytes for a `scrape_webpage` or a `web_search`.
 *
 * A `WeakMap` is exactly the right shape here: a part is immutable and is
 * REPLACED rather than mutated when it changes (`sync-store` swaps the element),
 * so the key is a natural version stamp, and entries die with the parts.
 */
const OUTCOME_CACHE = new WeakMap<
  Pick<ToolPart, 'state'>,
  { state: ToolPart['state']; outcome: ToolOutcome }
>();

function computeOutcome(part: Pick<ToolPart, 'state'>): ToolOutcome {
  const state = part.state;
  if (state.status === 'error') return 'failed';
  if (state.status !== 'completed') return 'ok';

  const output = typeof state.output === 'string' ? state.output.trim() : '';
  if (!output) return 'ok';
  if (looksLikeError(output)) return 'failed';

  // ONE parse answers both remaining questions. `isErrorOutput` → `parseJsonFailure`
  // parsed the whole output to ask "is this the {success:false} contract?", and
  // then `batchOutcome` parsed the identical string again to ask "does it hold a
  // results[] array?". Two passes over the same bytes, every call.
  const parsed = tryParseJson(output);
  if (parsed === undefined) return 'ok';
  if (isJsonFailure(parsed)) return 'failed';
  return batchOutcomeOf(parsed);
}

/** `undefined` when the text is not JSON — distinct from a parsed `undefined`. */
function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The boolean half of {@link parseJsonFailure}, without rebuilding its result. */
function isJsonFailure(parsed: unknown): boolean {
  return isJsonObject(parsed) && parsed.success === false && typeof parsed.error === 'string';
}

/**
 * A batch tool's per-item verdicts collapsed into one outcome.
 *
 * `scrape_webpage` returns `{total, successful, failed, results:[{success}]}`.
 * Two good pages and one dead host is a real and common result that is neither
 * "ok" nor "failed" — it earns amber, not red. Counted from `results[]` rather
 * than the sibling `failed` field because that field is optional, while the
 * array is the thing actually rendered in the card.
 */
function batchOutcomeOf(parsed: unknown): ToolOutcome {
  const results = isJsonObject(parsed) ? parsed.results : undefined;
  if (!Array.isArray(results) || results.length === 0) return 'ok';

  const failed = results.filter(
    (item) =>
      item !== null &&
      typeof item === 'object' &&
      (item as { success?: unknown }).success === false,
  ).length;

  if (failed === 0) return 'ok';
  return failed === results.length ? 'failed' : 'partial';
}

/**
 * Parse the `{success:false,error,hint?}` failure contract out of a tool's
 * output. Returns null when the output isn't that contract.
 *
 * The parsed JSON must be a plain OBJECT before any field is read. A tool that
 * returns the literal `null` (or any JSON value that parses to a non-object —
 * `true`, `5`, `"x"`, …) used to reach `parsed.success` on `null` and throw
 * `Cannot read properties of null (reading 'success')`, which crashed the
 * session page's turn render via `partOutcome` → `isErrorOutput` → here
 * (Better Stack patterns `487ae241…` / `ce68779d…`, prod v0.12.4). Any value
 * that isn't an object is, by definition, not the failure contract → null.
 */
export function parseJsonFailure(output: string): ParsedJsonFailure | null {
  const trimmed = output.trim();
  if (!trimmed) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (!isJsonObject(parsed)) return null;
  if (parsed.success !== false || typeof parsed.error !== 'string') return null;

  const result: ParsedJsonFailure = {
    errorSummary: parsed.error.trim(),
    hint: typeof parsed.hint === 'string' ? parsed.hint.trim() : undefined,
  };

  const nestedMatch = result.errorSummary.match(/:\s*(\{[\s\S]*\})\s*$/);
  if (!nestedMatch) return result;

  try {
    const nested = JSON.parse(nestedMatch[1]) as Record<string, unknown>;
    if (typeof nested.message === 'string' && nested.message.trim()) {
      result.nestedMessage = nested.message.trim();
    }
    if (typeof nested.status === 'number') {
      result.status = nested.status;
    }
    if (typeof nested.error === 'boolean') {
      result.nestedError = nested.error;
    }
  } catch {}

  return result;
}

/**
 * Normalize a backend error string for display: strip the noisy, often
 * duplicated `Error:` prefixes (e.g. "Error: … Error: Error: …") and collapse
 * whitespace, so the panel shows one calm sentence instead of stack-y jargon.
 * Falls back to the trimmed original if cleaning would empty the string.
 */
export function cleanErrorMessage(raw: string): string {
  const cleaned = raw
    .replace(/^(?:\s*Error:\s*)+/i, '')
    .replace(/(?:\bError:\s*){2,}/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || raw.trim();
}

/**
 * Format the `{success:false,error,hint?}` failure contract as a plain text
 * block (error + nested message + hint). Returns null when the output isn't
 * that contract. Same null-object guard as {@link parseJsonFailure} — a tool
 * that returns the literal `null` is not the failure contract.
 */
export function formatJsonFailureOutput(output: string): string | null {
  const trimmed = output.trim();
  if (!trimmed) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (!isJsonObject(parsed)) return null;

  const success = parsed.success;
  const error = parsed.error;
  const hint = parsed.hint;

  if (success !== false || typeof error !== 'string') return null;

  const lines: string[] = [];
  lines.push(error.trim());

  const nestedMatch = error.match(/:\s*(\{[\s\S]*\})\s*$/);
  if (nestedMatch) {
    try {
      const nested = JSON.parse(nestedMatch[1]) as Record<string, unknown>;
      const nestedMessage = nested.message;
      if (typeof nestedMessage === 'string' && nestedMessage.trim()) {
        lines.push(`Details: ${nestedMessage.trim()}`);
      }
    } catch {}
  }

  if (typeof hint === 'string' && hint.trim()) {
    lines.push(`Hint: ${hint.trim()}`);
  }

  return lines.join('\n\n');
}
