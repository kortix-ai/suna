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

/**
 * The EXPANDED reading of a step — concrete, not summarised.
 *
 * `stepLabel` answers "what kind of thing was this" and is right for a
 * collapsed summary. Inside an opened run it is actively bad: a run of shell
 * calls with no model-authored description renders as "Ran a command" eleven
 * times, and the reader cannot tell the rows apart or find the one they want.
 *
 * So an expanded row shows the argument that identifies the step — the command
 * itself, the file, the pattern — in mono, exactly as the transcript did before
 * this work. The verb stays as a plain-language prefix where it adds meaning,
 * and is dropped for shell (the `$` says it).
 */
export interface StepDetail {
  /** Plain-language prefix; '' for shell, where `$` carries it. */
  verb: string;
  /** The identifying argument, rendered monospace. May be ''. */
  mono: string;
  /** True for shell steps, which get a `$` gutter. */
  shell: boolean;
}

export function stepDetail(part: Pick<ToolPart, 'tool' | 'state'>): StepDetail {
  const input = ((part.state as { input?: Record<string, unknown> })?.input ?? {}) as Record<
    string,
    unknown
  >;
  const name = normalizeActivityToolName(part.tool);

  if (name === 'bash') {
    const command = ((input.command as string) ?? '').trim();
    // First line only — a heredoc or a && chain would otherwise blow the row's
    // height open. The full text is one more click away in the tool output.
    const firstLine = command.split('\n')[0] ?? '';
    return { verb: '', mono: firstLine, shell: true };
  }

  const arg = firstPathArg(input);
  const verb =
    TOOL_VERBS[name] ?? name.replace(/[-_]/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
  // Full path, not just the basename: in an expanded list two files can share
  // a name, and the folder is what tells them apart.
  return { verb, mono: arg ?? '', shell: false };
}
