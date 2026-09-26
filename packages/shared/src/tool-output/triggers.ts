import { isLineTerminator, lineTables } from './scan';

// `trigger_list` prints one row per trigger:
// `[status] name | cron: <schedule> | from → agent | last_run: <time>`. The row
// regex had two backtracking points: the name's `\S+` could end at any `|`
// inside it, and the lazy source detail retried the whole tail from every
// position. A source detail holding 240k spaces took 43.7 s, and a name
// holding 34k `|cron:x` choices took 7.0 s. The reader here resolves each
// choice with per-row lookups built in one pass.

const PIPE = 124; // |
const ARROW = 0x2192; // →
const BRACKET_OPEN = 91; // [
const BRACKET_CLOSE = 93; // ]

/** The row's fields, in the regex's group order. */
type TriggerRow = [string, string, string, string, string, string, string];

/**
 * A trigger row's seven fields, as
 * `/^\[(\w+)]\s+(\S+)\s*\|\s*(webhook|cron):\s*(.+?)\s*\|\s*(\w+)\s*→\s*(\w+)\s*\|\s*last_run:\s*(.+)$/`
 * captured them from a trimmed line: status, name, source type, source
 * detail, from, agent, last run. Null when the row does not match.
 */
export function triggerLineFields(line: string): TriggerRow | null {
  if (line.charCodeAt(0) !== BRACKET_OPEN || !line.includes('last_run:')) return null;
  const n = line.length;
  const t = lineTables(line);
  const space = (i: number) => t.spaceEnd[i] as number;
  const word = (i: number) => t.wordEnd[i] as number;

  // `\s*\|\s*(\w+)\s*→\s*(\w+)\s*\|\s*last_run:\s*(.+)$` from `at` has no
  // choices. tailEnd walks it without copying text: -1 when it fails, else
  // where the last-run field starts. tail then reads its three fields.
  const tailEnd = (at: number): number => {
    const pipe = space(at);
    if (line.charCodeAt(pipe) !== PIPE) return -1;
    const fromStart = space(pipe + 1);
    const fromEnd = word(fromStart);
    if (fromEnd === fromStart) return -1;
    const arrow = space(fromEnd);
    if (line.charCodeAt(arrow) !== ARROW) return -1;
    const agentStart = space(arrow + 1);
    const agentEnd = word(agentStart);
    if (agentEnd === agentStart) return -1;
    const pipe2 = space(agentEnd);
    if (line.charCodeAt(pipe2) !== PIPE) return -1;
    const label = space(pipe2 + 1);
    if (!line.startsWith('last_run:', label)) return -1;
    const runStart = space(label + 9);
    // `(.+)$`: the rest of the line, which may not hold a line terminator.
    if (runStart < n) return (t.breakAt[runStart] as number) === n ? runStart : -1;
    // Only whitespace follows: `\s*` gives back the last character, if `.` takes it.
    return n - 1 >= label + 9 && !isLineTerminator(line.charCodeAt(n - 1)) ? n - 1 : -1;
  };
  const tail = (at: number): [string, string, string] | null => {
    const runStart = tailEnd(at);
    if (runStart === -1) return null;
    const fromStart = space(space(at) + 1);
    const arrow = space(word(fromStart));
    const agentStart = space(arrow + 1);
    return [
      line.slice(fromStart, word(fromStart)),
      line.slice(agentStart, word(agentStart)),
      line.slice(runStart),
    ];
  };

  const statusEnd = word(1);
  if (statusEnd === 1 || line.charCodeAt(statusEnd) !== BRACKET_CLOSE) return null;
  const nameStart = space(statusEnd + 1);
  if (nameStart === statusEnd + 1 || nameStart >= n) return null;
  const status = line.slice(1, statusEnd);

  // The rest of the row after the name and its `|` at `pipe`.
  let tails: { after: Int32Array } | null = null;
  const rest = (nameEnd: number, pipe: number): TriggerRow | null => {
    const typeStart = space(pipe + 1);
    let type: 'webhook' | 'cron';
    let afterType: number;
    if (line.startsWith('webhook:', typeStart)) {
      type = 'webhook';
      afterType = typeStart + 8;
    } else if (line.startsWith('cron:', typeStart)) {
      type = 'cron';
      afterType = typeStart + 5;
    } else {
      return null;
    }
    const detailStart = space(afterType);
    // `(.+?)`: the first tail after at least one character, on the same line.
    if (detailStart < n) {
      if (!tails) {
        // Built once per row: where the tail can start.
        const after = new Int32Array(n + 2);
        after[n + 1] = -1;
        for (let e = n; e >= 0; e--) after[e] = tailEnd(e) !== -1 ? e : (after[e + 1] as number);
        tails = { after };
      }
      const end = tails.after[detailStart + 1] as number;
      if (end !== -1 && end <= (t.breakAt[detailStart] as number)) {
        const fields = tail(end);
        if (fields)
          return [
            status,
            line.slice(nameStart, nameEnd),
            type,
            line.slice(detailStart, end),
            ...fields,
          ];
      }
    }
    // The regex then gives whitespace back to `(.+?)`: when the tail starts at
    // `detailStart`, the detail is the last whitespace character `.` accepts.
    const fields = tail(detailStart);
    if (!fields) return null;
    for (let i = detailStart - 1; i >= afterType; i--) {
      if (!isLineTerminator(line.charCodeAt(i))) {
        return [status, line.slice(nameStart, nameEnd), type, line[i] ?? '', ...fields];
      }
    }
    return null;
  };

  // `\S+` is greedy: the name takes its whole run first, then ends at each `|`
  // inside it, last first.
  const nameRunEnd = t.solidEnd[nameStart] as number;
  const afterName = space(nameRunEnd);
  if (line.charCodeAt(afterName) === PIPE) {
    const row = rest(nameRunEnd, afterName);
    if (row) return row;
  }
  for (
    let pipe = line.lastIndexOf('|', nameRunEnd - 1);
    pipe > nameStart;
    pipe = line.lastIndexOf('|', pipe - 1)
  ) {
    const row = rest(pipe, pipe);
    if (row) return row;
  }
  return null;
}

export type TriggerLine =
  | { raw: string }
  | {
      status: string;
      name: string;
      sourceType: 'webhook' | 'cron';
      sourceDetail: string;
      agent: string;
      lastRun: string;
    };

/** Every output line starting with `[`, parsed when it matches the listing shape. */
export function parseTriggerLines(output: string): TriggerLine[] {
  if (!output) return [];
  return output
    .split('\n')
    .filter((l) => l.trim().startsWith('['))
    .map((line) => {
      const m = triggerLineFields(line.trim());
      if (!m) return { raw: line.trim() };
      return {
        status: m[0],
        name: m[1],
        sourceType: m[2] as 'webhook' | 'cron',
        sourceDetail: m[3].trim(),
        agent: m[5],
        lastRun: m[6].trim(),
      };
    });
}
