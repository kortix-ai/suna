/**
 * The `<kortix_system type="session-report">` block a finished child session
 * reports back with: its session id, status, agent, prompt and result.
 *
 * Linear time: the regex this replaced was cubic (7.6 s at 60k characters),
 * and every viewer of a session parses every user message in it.
 */
import { textBetween } from './text-scan';

export interface SessionReport {
  sessionId: string;
  status: 'COMPLETE' | 'FAILED';
  /** The project agent the child ran as. */
  project: string;
  prompt: string;
  /** The child's result XML (`<task_result>` / `<task_error>`). */
  result: string;
}

const OPEN = '<kortix_system';
const CLOSE = '</kortix_system>';

/** The first session report a text carries, or null. */
export function extractSessionReport(text: string): SessionReport | null {
  if (!text) return null;
  const xml = sessionReportXml(text);
  if (xml === null) return null;
  const get = (tag: string) => textBetween(xml, `<${tag}>`, `</${tag}>`)?.trim() || '';
  return {
    sessionId: get('session-id'),
    status: get('status') === 'FAILED' ? 'FAILED' : 'COMPLETE',
    project: get('project'),
    prompt: get('prompt'),
    result: get('result'),
  };
}

/** `A`–`Z` to `a`–`z` and nothing else: the case folding of a regex `i` flag without `u`. */
function fold(code: number): number {
  return code >= 65 && code <= 90 ? code + 32 : code;
}

/** `text.indexOf(needle, from)`, ignoring ASCII case as a regex `i` flag without `u` does. */
function indexOfIgnoreCase(text: string, needle: string, from = 0): number {
  const length = needle.length;
  let i = Math.max(from, 0);
  if (length === 0) return Math.min(i, text.length);
  const last = text.length - length;
  const first = fold(needle.charCodeAt(0));
  const firstIsLetter = first >= 97 && first <= 122;
  for (; i <= last; i++) {
    if (firstIsLetter) {
      if (fold(text.charCodeAt(i)) !== first) continue;
    } else {
      // A first character with no case: let the native search jump to it.
      i = text.indexOf(needle[0]!, i);
      if (i === -1 || i > last) return -1;
    }
    let j = 1;
    while (j < length && fold(text.charCodeAt(i + j)) === fold(needle.charCodeAt(j))) j++;
    if (j === length) return i;
  }
  return -1;
}

/**
 * The text between `<session-report>` and `</session-report>` after the first
 * `<kortix_system …>` tag that holds `type="session-report"`, with a closing
 * `</kortix_system>` after it — what
 * `/<kortix_system[^>]*type="session-report"[^>]*>[\s\S]*?<session-report>([\s\S]*?)<\/session-report>[\s\S]*?<\/kortix_system>/i`
 * captured.
 */
function sessionReportXml(text: string): string | null {
  const marker = 'type="session-report"';
  let from = 0;
  // The first marker at or after the last position searched from; -2 until searched.
  let markerAt = -2;
  for (;;) {
    const open = indexOfIgnoreCase(text, OPEN, from);
    if (open === -1) return null;
    const attrs = open + OPEN.length;
    const gt = text.indexOf('>', attrs);
    if (gt === -1) return null;
    if (markerAt < attrs) markerAt = indexOfIgnoreCase(text, marker, attrs);
    if (markerAt === -1) return null;
    // The marker lies past this tag. Every opener before `gt` shares this tag's
    // attributes, so none of them holds the marker either.
    if (markerAt > gt) {
      from = gt;
      continue;
    }
    // Each search below failing means no later opener can succeed: its search starts later still.
    const start = indexOfIgnoreCase(text, '<session-report>', gt + 1);
    if (start === -1) return null;
    const stop = indexOfIgnoreCase(text, '</session-report>', start + 16);
    if (stop === -1) return null;
    if (indexOfIgnoreCase(text, CLOSE, stop + 17) === -1) return null;
    return text.slice(start + 16, stop);
  }
}
