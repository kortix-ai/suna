import { indexOfIgnoreCase } from '../tag-blocks';
import { lineTables } from './scan';

// `session_list_background` prints one worker per row, as
// `**ses_…** · status: <word> · project: <path>`. Its renderers read the rows
// with /\*\*(ses_\S+)\*\*.*?status:\s*(\w+).*?project:\s*(\S+)/gi, which
// backtracks at three points: the id can end at any `**` inside it, the lazy
// search can reach any later `status:` on the line, and the status word can
// give back a `project` glued to its end. 80k `**` in one id took 5.1 s, and
// 10k starts before 10k statuses that never reach a project ran for over 60 s.
// A status's outcome does not depend on where the match started, so the
// reader computes each one once and resolves every start with binary searches.

export interface BackgroundWorker {
  id: string;
  status: string;
  project: string;
  prompt: string;
}

const COLON = 58; // :

/** The sorted positions of every occurrence of `needle`, overlapping ones included. */
function occurrences(text: string, needle: string, ignoreCase: boolean): number[] {
  const positions: number[] = [];
  const find = (from: number) =>
    ignoreCase ? indexOfIgnoreCase(text, needle, from) : text.indexOf(needle, from);
  for (let at = find(0); at !== -1; at = find(at + 1)) positions.push(at);
  return positions;
}

/** The first index whose value is at least `value`, or the length of the list. */
function lowerBound(list: readonly number[], value: number): number {
  let low = 0;
  let high = list.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((list[middle] as number) < value) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** `ses_` at `at`, ignoring ASCII case as the regex's `i` flag did. */
function sessionPrefixAt(text: string, at: number): boolean {
  return indexOfIgnoreCase(text.slice(at, at + 4), 'ses_') === 0;
}

/**
 * Every worker of a `session_list_background` output, as the loop over
 * `/\*\*(ses_\S+)\*\*.*?status:\s*(\w+).*?project:\s*(\S+)/gi` read them.
 */
export function parseBackgroundWorkers(output: string): BackgroundWorker[] {
  if (!output) return [];
  const entries: BackgroundWorker[] = [];
  const stars = occurrences(output, '**', false);
  const statuses = stars.length > 0 ? occurrences(output, 'status:', true) : [];
  if (statuses.length === 0) return entries;
  const projects = occurrences(output, 'project:', true);
  const n = output.length;
  const t = lineTables(output);
  const space = (i: number) => t.spaceEnd[i] as number;

  // `\s*(\S+)` after the `project:` at `at`: the project's span, or null when
  // only whitespace follows.
  const projectAt = (at: number): [number, number] | null => {
    const start = space(at + 8);
    return start < n ? [start, t.solidEnd[start] as number] : null;
  };

  // What `status:\s*(\w+).*?project:\s*(\S+)` reads from each status:
  // [word start, word end, project start, project end], or null.
  const outcomes = statuses.map((at): [number, number, number, number] | null => {
    const wordStart = space(at + 7);
    const wordEnd = t.wordEnd[wordStart] as number;
    if (wordEnd === wordStart) return null;
    // The whole word first: the first `project:` after it, on its line.
    const first = projects[lowerBound(projects, wordEnd)];
    if (first !== undefined && first < (t.breakAt[wordEnd] as number)) {
      const project = projectAt(first);
      if (project) return [wordStart, wordEnd, ...project];
    }
    // Then a shorter word: only a word that ends in `project`, before a `:`,
    // gives back a `project:` of its own.
    const glued = wordEnd - 7;
    if (
      glued > wordStart &&
      output.charCodeAt(wordEnd) === COLON &&
      projects[lowerBound(projects, glued)] === glued
    ) {
      const project = projectAt(glued);
      if (project) return [wordStart, glued, ...project];
    }
    return null;
  });
  // The nearest status with an outcome, at or before / at or after each index.
  const lastOk = new Int32Array(statuses.length);
  const nextOk = new Int32Array(statuses.length + 1);
  for (let i = 0; i < statuses.length; i++)
    lastOk[i] = outcomes[i] ? i : i > 0 ? (lastOk[i - 1] as number) : -1;
  nextOk[statuses.length] = -1;
  for (let i = statuses.length - 1; i >= 0; i--)
    nextOk[i] = outcomes[i] ? i : (nextOk[i + 1] as number);

  let from = 0;
  for (let star = lowerBound(stars, from); star < stars.length; star = lowerBound(stars, from)) {
    const start = stars[star] as number;
    from = start + 1;
    if (!sessionPrefixAt(output, start + 2)) continue;
    // `ses_\S+`: the id runs to the end of its non-whitespace run at most.
    const runEnd = t.solidEnd[start + 6] as number;
    if (runEnd === start + 6) continue;
    // The last status with an outcome that this start can reach: on the id's
    // line, after the shortest id.
    const reachable = lastOk[lowerBound(statuses, t.breakAt[runEnd] as number) - 1] ?? -1;
    if (reachable === -1) continue;
    // `\S+` is greedy: the id ends at the last `**` in its run that still has
    // that status after it. A status inside the shortest id leaves none.
    const idEnd = stars[lowerBound(stars, Math.min(runEnd, statuses[reachable] as number) - 1) - 1];
    if (idEnd === undefined || idEnd < start + 7) continue;
    const outcome = outcomes[nextOk[lowerBound(statuses, idEnd + 2)] as number];
    if (!outcome) continue;
    const [wordStart, wordEnd, projectStart, projectEnd] = outcome;
    entries.push({
      id: output.slice(start + 2, idEnd),
      status: output.slice(wordStart, wordEnd),
      project: output.slice(projectStart, projectEnd),
      prompt: '',
    });
    from = projectEnd;
  }
  return entries;
}
