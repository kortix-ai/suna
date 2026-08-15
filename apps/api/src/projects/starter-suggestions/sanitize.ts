/** Constants for starter suggestion validation and pooling. */
export const POOL_SIZE = 9;
export const MIN_ITEMS = 6;
export const MAX_LABEL_CHARS = 60;
export const MAX_PROMPT_CHARS = 400;

/** Minimum prompt length after whitespace normalization. */
const MIN_PROMPT_CHARS = 10;

/** Max length of a raw `connector_slug` after trimming — shape only, not a
 *  real catalog check (see the two-stage note on `StarterSuggestionItem`). */
export const MAX_CONNECTOR_SLUG_CHARS = 100;

/** The setup actions a suggestion may point at instead of (or alongside) a
 *  plain prompt — the composer surfaces one of these as a shortcut into the
 *  matching workspace panel. */
export const SUGGESTION_ACTIONS = [
  'connectors',
  'skills',
  'schedules',
  'agent',
  'members',
  'channels',
] as const;

export type SuggestionAction = (typeof SUGGESTION_ACTIONS)[number];

/**
 * Individual starter suggestion item with generated id. `action` is present
 * only when the model named a setup step and that name validated against
 * `SUGGESTION_ACTIONS` — otherwise the key is omitted entirely rather than
 * set to `undefined`, so a plain prompt item round-trips with no extra key.
 *
 * **Two-stage connector design**, mirroring how untrusted model output is
 * generally handled here (parse-shape now, verify-against-reality later):
 *
 *   1. `connectorSlug` — RAW and UNVERIFIED. `parseSuggestions` only checks
 *      that the model produced a plausible string (trimmed, non-empty, ≤
 *      `MAX_CONNECTOR_SLUG_CHARS`); anything else strips the key but keeps
 *      the item. It is never checked against a real catalog here — this
 *      module has no catalog to check against, only the model's JSON.
 *   2. `connector` — ENRICHED, and set ONLY by the generator
 *      (`generate.ts`), which validates `connectorSlug` against the exact
 *      `availableConnectors` offer collected for that run and, on a match,
 *      replaces it with this real `{ slug, name, img_src }` reference. An
 *      unmatched/invalid slug is dropped (the item survives as a plain
 *      suggestion). `connectorSlug` never reaches persistence — only
 *      `connector` does.
 */
export interface StarterSuggestionItem {
  id: string;
  label: string;
  prompt: string;
  action?: SuggestionAction;
  /** Raw, unverified — see the two-stage note above. */
  connectorSlug?: string;
  /** Enriched, generator-set only — see the two-stage note above. */
  connector?: { slug: string; name: string; img_src: string | null };
}

function isValidAction(value: unknown): value is SuggestionAction {
  return typeof value === 'string' && (SUGGESTION_ACTIONS as readonly string[]).includes(value);
}

function isValidConnectorSlug(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.trim().length <= MAX_CONNECTOR_SLUG_CHARS
  );
}

/** Parse and validate model-generated suggestions: accepts bare JSON arrays,
 *  `{ "suggestions": [...] }` wrappers, or either wrapped in triple-backtick
 *  fences. Collapses whitespace, enforces char bounds, drops undersized prompts,
 *  and returns null if fewer than MIN_ITEMS survive. */
export function parseSuggestions(raw: string | null | undefined): StarterSuggestionItem[] | null {
  if (typeof raw !== 'string') return null;

  // Strip fence if present (``` or ```json).
  let stripped = raw.trim();
  if (stripped.startsWith('```json\n')) {
    stripped = stripped.slice('```json\n'.length);
  } else if (stripped.startsWith('```\n')) {
    stripped = stripped.slice('```\n'.length);
  }
  if (stripped.endsWith('\n```')) {
    stripped = stripped.slice(0, -'\n```'.length);
  }
  stripped = stripped.trim();

  // Parse JSON.
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    return null;
  }

  // Extract array: bare array or { suggestions: [...] }.
  let items: unknown[];
  if (Array.isArray(parsed)) {
    items = parsed;
  } else if (parsed !== null && typeof parsed === 'object' && 'suggestions' in parsed) {
    const suggestions = (parsed as Record<string, unknown>).suggestions;
    if (!Array.isArray(suggestions)) return null;
    items = suggestions;
  } else {
    return null;
  }

  // Validate and sanitize each item.
  const validated: StarterSuggestionItem[] = [];
  for (const item of items) {
    if (item === null || typeof item !== 'object') continue;

    const obj = item as Record<string, unknown>;
    const rawLabel = obj.label;
    const rawPrompt = obj.prompt;

    // Type check.
    if (typeof rawLabel !== 'string' || typeof rawPrompt !== 'string') continue;

    // Normalize whitespace.
    let label = rawLabel.replace(/\s+/g, ' ').trim();
    let prompt = rawPrompt.replace(/\s+/g, ' ').trim();

    // Validate constraints.
    if (!label || !prompt) continue;
    if (label.length > MAX_LABEL_CHARS) continue;
    if (prompt.length > MAX_PROMPT_CHARS) continue;
    if (prompt.length < MIN_PROMPT_CHARS) continue;

    // A hallucinated/malformed action strips the field but keeps the item —
    // a bad action shouldn't cost an otherwise-good suggestion.
    const action = isValidAction(obj.action) ? obj.action : undefined;

    // Same policy for connector_slug: shape-invalid strips the key, keeps
    // the item. Whether it names a REAL, connectable app is not this
    // function's job — see the two-stage note on `StarterSuggestionItem`.
    const connectorSlug = isValidConnectorSlug(obj.connector_slug)
      ? obj.connector_slug.trim()
      : undefined;

    validated.push({
      label,
      prompt,
      id: '', // id assigned in pool phase
      ...(action ? { action } : {}),
      ...(connectorSlug ? { connectorSlug } : {}),
    });
  }

  // Return null if fewer than MIN_ITEMS survive.
  if (validated.length < MIN_ITEMS) return null;

  // Take first POOL_SIZE items and assign ids.
  return validated.slice(0, POOL_SIZE).map((item, idx) => ({
    ...item,
    id: `gen-${idx}`,
  }));
}
