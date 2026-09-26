import type { ConnectorAction } from '@kortix/sdk';

export interface ConnectorTryPrompt {
  /** The tool the prompt came from — the stable React key. */
  path: string;
  text: string;
}

const MAX_PROMPTS = 3;
const MAX_PROMPT_LENGTH = 90;

/**
 * "Lists the comments on a file." → "List the comments on a file".
 *
 * Tool descriptions are third-person by convention ("Lists", "Retrieves",
 * "Searches"). The prompt a person types is an instruction, so the leading
 * verb loses its `-s`/`-es`. Anything that does not open with such a verb
 * returns `null` — a prompt built from "The file endpoint" reads as
 * nonsense, and no row beats a wrong one.
 */
export function imperativeFromDescription(description: string): string | null {
  const sentence =
    description
      .trim()
      .split(/(?<=[.!?])\s/)[0]
      ?.replace(/[.!?]+$/, '') ?? '';
  const match = /^([A-Z][a-z]+)(\s.+)$/.exec(sentence);
  if (!match) return null;
  const [, verb, rest] = match;
  let base: string;
  if (/(ches|shes|sses|xes|zes)$/.test(verb)) base = verb.slice(0, -2);
  else if (/[^s]s$/.test(verb)) base = verb.slice(0, -1);
  else return null;
  const text = `${base}${rest}`;
  return text.length > MAX_PROMPT_LENGTH ? null : text;
}

/**
 * Up to three prompts a person can start a session with, derived from the
 * connector's OWN read tools (the Overview's "Try it in a session", Jay's R5
 * pick, 2026-09-26). Read tools only: a sample prompt one click from
 * running must never create, change, or delete anything.
 */
export function connectorTryPrompts(actions: readonly ConnectorAction[]): ConnectorTryPrompt[] {
  const prompts: ConnectorTryPrompt[] = [];
  const seen = new Set<string>();
  for (const action of actions) {
    if (prompts.length === MAX_PROMPTS) break;
    if (action.risk !== 'read' || !action.description) continue;
    const text = imperativeFromDescription(action.description);
    if (!text || seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    prompts.push({ path: action.path, text });
  }
  return prompts;
}
