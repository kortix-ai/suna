/** Constants for starter suggestion validation and pooling. */
export const POOL_SIZE = 9;
export const MIN_ITEMS = 6;
export const MAX_LABEL_CHARS = 60;
export const MAX_PROMPT_CHARS = 400;

/** Minimum prompt length after whitespace normalization. */
const MIN_PROMPT_CHARS = 10;

/** Individual starter suggestion item with generated id. */
export interface StarterSuggestionItem {
  id: string;
  label: string;
  prompt: string;
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

    validated.push({ label, prompt, id: '' }); // id assigned in pool phase
  }

  // Return null if fewer than MIN_ITEMS survive.
  if (validated.length < MIN_ITEMS) return null;

  // Take first POOL_SIZE items and assign ids.
  return validated.slice(0, POOL_SIZE).map((item, idx) => ({
    ...item,
    id: `gen-${idx}`,
  }));
}
