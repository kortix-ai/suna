import { normalizeActivityToolName } from '@/features/session/session-activity-groups';
import type { ToolPart } from '@/ui';
import { humanizeShellStep } from './humanize';

/**
 * One tool call as the phrase a non-technical reader would use for it.
 *
 * Lived in four places (three variant files and `session-chat.tsx`) and had
 * already started to drift. It is the single most-read string in the
 * transcript, so it gets one definition and a test.
 */

/** Tools whose interesting argument is a path, and the key it arrives under. */
const PATH_KEYS = ['filePath', 'path', 'file', 'pattern', 'query', 'url'] as const;

/** Verbs for the non-shell tools, so a row reads "Wrote index.html" rather
 *  than the raw tool name. Anything unlisted falls back to a de-slugged name. */
const TOOL_VERBS: Record<string, string> = {
  read: 'Read',
  write: 'Wrote',
  edit: 'Edited',
  apply_patch: 'Edited',
  multiedit: 'Edited',
  glob: 'Found files matching',
  grep: 'Searched for',
  list: 'Listed',
  web_search: 'Searched the web for',
  websearch: 'Searched the web for',
  webfetch: 'Fetched',
  web_fetch: 'Fetched',
  scrape: 'Read the page',
  scrape_webpage: 'Read the page',
};

function firstPathArg(input: Record<string, unknown>): string | undefined {
  for (const key of PATH_KEYS) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

/** Paths are shown by filename — the reader cares which file, not where the
 *  sandbox put it. URLs keep their host, which IS the identifying part. */
function shorten(arg: string): string {
  if (/^https?:\/\//i.test(arg)) {
    try {
      return new URL(arg).hostname.replace(/^www\./, '');
    } catch {
      return arg;
    }
  }
  if (arg.includes('/')) return arg.split('/').filter(Boolean).slice(-1)[0] || arg;
  return arg;
}

export function stepLabel(part: Pick<ToolPart, 'tool' | 'state'>): string {
  const input = ((part.state as { input?: Record<string, unknown> })?.input ?? {}) as Record<
    string,
    unknown
  >;
  const name = normalizeActivityToolName(part.tool);

  // Shell steps carry the model's own `description`, which beats any guess.
  if (name === 'bash') {
    return humanizeShellStep({
      description: input.description as string | undefined,
      command: input.command as string | undefined,
    });
  }

  const arg = firstPathArg(input);
  const verb = TOOL_VERBS[name];

  if (verb) return arg ? `${verb} ${shorten(arg)}` : verb;

  // Unknown tool: de-slug the name so it at least reads as words.
  const pretty = name.replace(/[-_]/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
  return arg ? `${pretty} · ${shorten(arg)}` : pretty;
}
