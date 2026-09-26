import { isDigit, isLineTerminator, isWhitespace, lineEnd, whitespaceEnd } from './scan';

// `session_get` prints a session as `=== SESSION: <title> ===`, labelled
// fields, a `Todos:` section, and `=== CONVERSATION (N msgs, M tool calls) ===`.
// Its renderers read these with regexes that retried long runs: a title holding
// 240k spaces took 44.4 s, a conversation header holding 240k digits took
// 45.7 s, and 30k `Created:` labels with no space took 2.9 s. The readers here
// scan each run once and return what the regexes returned.

/** `\s*===$` (with the `m` flag) at `from`: `===` after any whitespace, then a line end. */
function endsTitle(text: string, from: number): boolean {
  const at = whitespaceEnd(text, from);
  return (
    text.startsWith('===', at) &&
    (at + 3 === text.length || isLineTerminator(text.charCodeAt(at + 3)))
  );
}

/** The title that `\s*(.+?)\s*===$` captures after `=== SESSION:` ends at `from`, or null. */
function titleAfter(text: string, from: number): string | null {
  const start = whitespaceEnd(text, from);
  if (start < text.length) {
    // `(.+?)` takes at least one character and cannot cross a line terminator.
    const lastEnd = lineEnd(text, start);
    let end = start + 1;
    while (end < lastEnd) {
      if (endsTitle(text, end)) return text.slice(start, end);
      if (isWhitespace(text.charCodeAt(end))) {
        // Every position in a whitespace run has the same tail: skip the run.
        const runEnd = whitespaceEnd(text, end);
        if (runEnd >= lastEnd) break;
        end = runEnd;
      } else {
        end++;
      }
    }
    if (end === lastEnd && endsTitle(text, end)) return text.slice(start, end);
  }
  // The regex then gives back whitespace to `(.+?)`: when `===` ends the line
  // right after it, the title is the last whitespace character `.` accepts.
  if (!endsTitle(text, start)) return null;
  for (let i = start - 1; i >= from; i--) {
    if (!isLineTerminator(text.charCodeAt(i))) return text[i] ?? null;
  }
  return null;
}

/** The session title, as `/^=== SESSION:\s*(.+?)\s*===$/m` captured it. */
export function sessionTitle(text: string): string | null {
  const label = '=== SESSION:';
  for (let at = text.indexOf(label); at !== -1; at = text.indexOf(label, at + 1)) {
    if (at > 0 && !isLineTerminator(text.charCodeAt(at - 1))) continue;
    const title = titleAfter(text, at + label.length);
    if (title !== null) return title;
  }
  return null;
}

/**
 * The `<date> <time>` after `label`, as `/Created:\s*(\S+ \S+)/` captured it:
 * two runs of non-whitespace joined by one space.
 */
export function spacedPair(text: string, label: 'Created:' | 'Updated:'): string | null {
  // The last non-whitespace run measured: a label inside it ends at the same place.
  let runStart = -1;
  let runEnd = -1;
  const nonWhitespaceEnd = (from: number): number => {
    if (from >= runStart && from < runEnd) return runEnd;
    let i = from;
    while (i < text.length && !isWhitespace(text.charCodeAt(i))) i++;
    runStart = from;
    runEnd = i;
    return i;
  };
  for (let at = text.indexOf(label); at !== -1; at = text.indexOf(label, at + 1)) {
    const first = whitespaceEnd(text, at + label.length);
    // Only whitespace follows: no later label exists.
    if (first === text.length) return null;
    const space = nonWhitespaceEnd(first);
    if (text.charCodeAt(space) !== 32) continue;
    const second = space + 1;
    if (second === text.length || isWhitespace(text.charCodeAt(second))) continue;
    return text.slice(first, nonWhitespaceEnd(second));
  }
  return null;
}

/**
 * The `Todos:` section, as `/^Todos:\n([\s\S]*?)(?=\n(?:Lineage|Storage|===))/m`
 * captured it: from the first `Todos:` line to the next line that starts with
 * `Lineage`, `Storage`, or `===`.
 */
export function todosBody(text: string): string | null {
  const label = 'Todos:\n';
  for (let at = text.indexOf(label); at !== -1; at = text.indexOf(label, at + 1)) {
    if (at > 0 && !isLineTerminator(text.charCodeAt(at - 1))) continue;
    const start = at + label.length;
    // Only the first section counts: a later one ends where this one would.
    for (let end = text.indexOf('\n', start); end !== -1; end = text.indexOf('\n', end + 1)) {
      const next = end + 1;
      if (
        text.startsWith('Lineage', next) ||
        text.startsWith('Storage', next) ||
        text.startsWith('===', next)
      ) {
        return text.slice(start, end);
      }
    }
    return null;
  }
  return null;
}

/**
 * The first `=== CONVERSATION (…) ===` header, as
 * `/=== CONVERSATION \((.+?)\) ===/` matched it: its span and the text between
 * the parentheses, which is on one line and not empty.
 */
export function conversationHeader(
  text: string,
): { index: number; end: number; inner: string } | null {
  const open = '=== CONVERSATION (';
  const close = ') ===';
  // The next `) ===` at or after the last position it was searched from.
  let nextClose = -2;
  let from = 0;
  for (;;) {
    const at = text.indexOf(open, from);
    if (at === -1) return null;
    const inner = at + open.length;
    if (inner === text.length || isLineTerminator(text.charCodeAt(inner))) {
      from = at + 1;
      continue;
    }
    if (nextClose < inner + 1) nextClose = text.indexOf(close, inner + 1);
    // No closer after this header means none after a later one either.
    if (nextClose === -1) return null;
    const stop = lineEnd(text, inner);
    if (nextClose < stop)
      return { index: at, end: nextClose + close.length, inner: text.slice(inner, nextClose) };
    // A later header on this line reaches the same line end: skip the line.
    from = stop;
  }
}

/**
 * The digits right before the first `suffix` that follows a digit, as
 * `/(\d+) msgs?/` and `/(\d+) tool calls?/` captured them.
 */
export function digitsBefore(text: string, suffix: ' msg' | ' tool call'): string | null {
  for (let at = text.indexOf(suffix); at !== -1; at = text.indexOf(suffix, at + 1)) {
    let start = at;
    while (start > 0 && isDigit(text.charCodeAt(start - 1))) start--;
    if (start < at) return text.slice(start, at);
  }
  return null;
}

export interface ParsedSessionGetOutput {
  title: string;
  id: string;
  created: string;
  updated: string;
  changes: string;
  parent: string | null;
  todos: Array<{ status: string; text: string }>;
  msgCount: string;
  toolCount: string;
  compression: string | null;
  conversation: string;
  hasConversation: boolean;
}

/** A `session_get` output, as the renderers show it; null for an empty output. */
export function parseSessionGetOutput(output: string, sid: string): ParsedSessionGetOutput | null {
  if (!output) return null;
  const title = sessionTitle(output);
  const idMatch = output.match(/^ID:\s*(ses_\S+)/m);
  const created = spacedPair(output, 'Created:');
  const updated = spacedPair(output, 'Updated:');
  const changesMatch = output.match(/^Changes:\s*(.+)/m);
  const parentMatch = output.match(/^Parent:\s*(ses_\S+)/m);

  const todosSection = todosBody(output);
  const todos: Array<{ status: string; text: string }> = [];
  if (todosSection !== null) {
    for (const line of todosSection.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === '(none)') continue;
      const sm = trimmed.match(/^\[(\w+)\]\s*(.*)/);
      if (sm) todos.push({ status: sm[1], text: sm[2] });
      else todos.push({ status: 'pending', text: trimmed });
    }
  }

  const convHeader = conversationHeader(output);
  const msgCount = (convHeader && digitsBefore(convHeader.inner, ' msg')) || '0';
  const toolCount = (convHeader && digitsBefore(convHeader.inner, ' tool call')) || '0';
  const compressionMatch = output.match(/=== COMPRESSION ===\n(.+)/m);

  const convStart = convHeader ? convHeader.end : -1;
  const convEnd = compressionMatch ? output.indexOf('=== COMPRESSION ===') : output.length;
  const conversation = convStart > 0 ? output.slice(convStart, convEnd).trim() : '';

  return {
    title: title ?? 'Unknown Session',
    id: idMatch?.[1] ?? sid,
    created: created ?? '',
    updated: updated ?? '',
    changes: changesMatch?.[1] ?? '',
    parent: parentMatch?.[1] ?? null,
    todos,
    msgCount,
    toolCount,
    compression: compressionMatch?.[1]?.trim() ?? null,
    conversation,
    hasConversation: !!convHeader,
  };
}
