import { isDigit, lineTables, positionIndex } from './scan';

// `session_search` prints one row per hit: `ses_… | "<title>" | <updated> |
// score=N`. The row regex had three backtracking points: the id's `\S+` could
// end at any `|` inside it, `(\S+.*?)` tried every length of its `\S+` and
// every end of its `.*?`, and each try rescanned the tail. A row whose date
// held 240k characters took 24.6 s; an id holding 48k `|"t"|` choices ran for
// over a minute. The reader here precomputes, per row, where the tail
// `\s*\|\s*score=\d` can start, so each choice costs one lookup.

const PIPE = 124; // |
const QUOTE = 34; // "

/**
 * The fields of one result row, as
 * `/^(ses_\S+)\s*\|\s*"([^"]*)"\s*\|\s*(\S+.*?)\s*\|\s*score=(\d+)/` captured
 * them: id, title, updated, score. Null when the row does not match.
 */
export function searchHitRow(line: string): [string, string, string, string] | null {
  if (!line.startsWith('ses_') || !line.includes('score=')) return null;
  const n = line.length;
  const t = lineTables(line);
  // Where `\s*\|\s*score=(\d+)` can start.
  const tail = positionIndex(n, (e) => {
    const pipe = t.spaceEnd[e] as number;
    if (line.charCodeAt(pipe) !== PIPE) return false;
    const label = t.spaceEnd[pipe + 1] as number;
    return line.startsWith('score=', label) && isDigit(line.charCodeAt(label + 6));
  });
  const idRunEnd = t.solidEnd[4] as number;
  if (idRunEnd === 4) return null;

  // The rest of the row after the id and its `|` at `pipe`.
  const rest = (idEnd: number, pipe: number): [string, string, string, string] | null => {
    const open = t.spaceEnd[pipe + 1] as number;
    if (line.charCodeAt(open) !== QUOTE) return null;
    const close = line.indexOf('"', open + 1);
    if (close === -1) return null;
    const pipe2 = t.spaceEnd[close + 1] as number;
    if (line.charCodeAt(pipe2) !== PIPE) return null;
    const start = t.spaceEnd[pipe2 + 1] as number;
    if (start >= n) return null;
    // `(\S+.*?)`: the longest `\S+` first, so the first tail at or after the
    // end of its run, on its line; else the last tail inside the run.
    const runEnd = t.solidEnd[start] as number;
    let end = tail.after[runEnd] as number;
    if (end === -1 || end > (t.breakAt[runEnd] as number)) {
      end = tail.before[runEnd - 1] as number;
      if (end < start + 1) return null;
    }
    const label = t.spaceEnd[(t.spaceEnd[end] as number) + 1] as number;
    let digits = label + 6;
    while (isDigit(line.charCodeAt(digits))) digits++;
    return [
      line.slice(0, idEnd),
      line.slice(open + 1, close),
      line.slice(start, end),
      line.slice(label + 6, digits),
    ];
  };

  // `ses_\S+` is greedy: the whole run first, then each `|` inside it, last first.
  const afterRun = t.spaceEnd[idRunEnd] as number;
  if (line.charCodeAt(afterRun) === PIPE) {
    const hit = rest(idRunEnd, afterRun);
    if (hit) return hit;
  }
  for (
    let pipe = line.lastIndexOf('|', idRunEnd - 1);
    pipe >= 5;
    pipe = line.lastIndexOf('|', pipe - 1)
  ) {
    const hit = rest(pipe, pipe);
    if (hit) return hit;
  }
  return null;
}

export interface SessionSearchHit {
  id: string;
  title: string;
  updated: string;
  score: string;
  snippet: string;
}

/** Every hit of a `session_search` output, with the snippet line under it. */
export function parseSessionSearchHits(output: string): SessionSearchHit[] {
  if (!output) return [];
  const results: SessionSearchHit[] = [];
  const lines = output.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = searchHitRow(lines[i] ?? '');
    if (m) {
      const snippetLine = lines[i + 1]?.match(/^Snippet:\s*(.+)/);
      results.push({
        id: m[0],
        title: m[1],
        updated: m[2].trim(),
        score: m[3],
        snippet: snippetLine?.[1]?.trim() || '',
      });
    }
  }
  return results;
}
