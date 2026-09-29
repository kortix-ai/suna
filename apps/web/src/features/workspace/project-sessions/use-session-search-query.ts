import { useDebounce } from '@/hooks/use-debounced-value';
import { sessionSearchParam } from '@kortix/sdk';

/** Milliseconds between the last keystroke and the server search. */
const SEARCH_DEBOUNCE_MS = 250;

/**
 * The `q` a session search sends for typed text, debounced so a keystroke is
 * not a request: trimmed, capped at the API's 200 characters (it answers 400
 * above that), and '' when blank. The sessions page and the command palette
 * both search through this.
 */
export function useSessionSearchQuery(text: string): string {
  return useDebounce(sessionSearchParam(text) ?? '', SEARCH_DEBOUNCE_MS);
}
