import { isDigit, isLineTerminator, lineEnd, whitespaceEnd } from './scan';

// Edit and write tools append LSP diagnostics as `<file_diagnostics>` or
// `<project_diagnostics>` blocks of `Error: path:line:col [source] message`
// lines. The block regex rescanned the rest of the output for every opener
// that never closed (12.5k took 721 ms), and the line regex rescanned for a
// `]` from every `:` its lazy path tried (40k took 3.5 s). The readers below
// search each delimiter once and return what the regexes returned.

const COLON = 58; // :
const BRACKET_OPEN = 91; // [
const OPENERS = ['<file_diagnostics>', '<project_diagnostics>'] as const;
const CLOSERS = ['</file_diagnostics>', '</project_diagnostics>'] as const;
const SEVERITIES = ['Error', 'Warn', 'Info', 'Hint'] as const;

/**
 * The body of every diagnostics block, as the loop over
 * `/<(?:file_diagnostics|project_diagnostics)>([\s\S]*?)<\/(?:file_diagnostics|project_diagnostics)>/g`
 * read them: either opener pairs with the first closer of either name.
 */
export function diagnosticBlocks(output: string): string[] {
  const bodies: string[] = [];
  // The next occurrence of each tag at or after the last search; -2: not searched.
  const nextOpen = OPENERS.map(() => -2);
  const nextClose = CLOSERS.map(() => -2);
  const first = (tags: readonly string[], next: number[], from: number): [number, number] => {
    let at = -1;
    let length = 0;
    for (const [index, tag] of tags.entries()) {
      if ((next[index] as number) !== -1 && (next[index] as number) < from)
        next[index] = output.indexOf(tag, from);
      const found = next[index] as number;
      if (found !== -1 && (at === -1 || found < at)) {
        at = found;
        length = tag.length;
      }
    }
    return [at, length];
  };
  let from = 0;
  for (;;) {
    const [open, openLength] = first(OPENERS, nextOpen, from);
    if (open === -1) break;
    const [close, closeLength] = first(CLOSERS, nextClose, open + openLength);
    // No closer after this opener means none after a later one either.
    if (close === -1) break;
    bodies.push(output.slice(open + openLength, close));
    from = close + closeLength;
  }
  return bodies;
}

/**
 * One diagnostic line's fields, as
 * `/^(Error|Warn|Info|Hint):\s+(.+?):(\d+):(\d+)\s+\[([^\]]*)\](.*)$/`
 * captured them: severity, path, line, column, source, message.
 */
export function diagnosticLine(line: string): string[] | null {
  const severity = SEVERITIES.find(
    (word) => line.startsWith(word) && line.charCodeAt(word.length) === COLON,
  );
  if (!severity) return null;
  const afterColon = severity.length + 1;
  const pathStart = whitespaceEnd(line, afterColon);
  // `\s+` takes at least one character.
  if (pathStart === afterColon) return null;
  // `(.*)$` takes the rest of the line, which may not hold a line terminator.
  let lastBreak = -1;
  for (let i = line.length - 1; i >= 0; i--) {
    if (isLineTerminator(line.charCodeAt(i))) {
      lastBreak = i;
      break;
    }
  }
  // `:(\d+):(\d+)\s+\[([^\]]*)\](.*)$` after the path, which ends at `colon`.
  let nextBracket = -2;
  const fieldsAfter = (colon: number, close: (open: number) => number): string[] | null => {
    let lineEnd1 = colon + 1;
    while (isDigit(line.charCodeAt(lineEnd1))) lineEnd1++;
    if (lineEnd1 === colon + 1 || line.charCodeAt(lineEnd1) !== COLON) return null;
    let columnEnd = lineEnd1 + 1;
    while (isDigit(line.charCodeAt(columnEnd))) columnEnd++;
    if (columnEnd === lineEnd1 + 1) return null;
    const open = whitespaceEnd(line, columnEnd);
    if (open === columnEnd || line.charCodeAt(open) !== BRACKET_OPEN) return null;
    const bracket = close(open + 1);
    if (bracket === -1 || lastBreak > bracket) return null;
    return [
      line.slice(colon + 1, lineEnd1),
      line.slice(lineEnd1 + 1, columnEnd),
      line.slice(open + 1, bracket),
      line.slice(bracket + 1),
    ];
  };
  // The forward candidates search for `]` from increasing positions: remember it.
  const cachedClose = (from: number) => {
    if (nextBracket < from) nextBracket = line.indexOf(']', from);
    return nextBracket;
  };
  // `(.+?)` is lazy: the first colon after at least one character, on one line.
  const pathStop = lineEnd(line, pathStart);
  for (
    let colon = line.indexOf(':', pathStart + 1);
    colon !== -1 && colon <= pathStop;
    colon = line.indexOf(':', colon + 1)
  ) {
    const fields = fieldsAfter(colon, cachedClose);
    if (fields) return [severity, line.slice(pathStart, colon), ...fields];
  }
  // Then `\s+` gives back its last character, which becomes the path, when a
  // colon follows it directly.
  const given = pathStart - 1;
  if (
    given > afterColon &&
    !isLineTerminator(line.charCodeAt(given)) &&
    line.charCodeAt(pathStart) === COLON
  ) {
    const fields = fieldsAfter(pathStart, (from) => line.indexOf(']', from));
    if (fields) return [severity, line.slice(given, pathStart), ...fields];
  }
  return null;
}

export type DiagnosticSeverity = 1 | 2 | 3 | 4;

export interface LspDiagnostic {
  file: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  severity: DiagnosticSeverity;
  message: string;
  source?: string;
}

/** `<file_diagnostics>` / `<project_diagnostics>` blocks → diagnostics by file (0-indexed). */
export function parseDiagnosticsFromToolOutput(output: string): Record<string, LspDiagnostic[]> {
  const result: Record<string, LspDiagnostic[]> = {};
  const allLines: string[] = [];
  for (const block of diagnosticBlocks(output)) {
    const content = block.trim();
    if (!content) continue;
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('...')) allLines.push(trimmed);
    }
  }
  if (allLines.length === 0) return result;

  for (const line of allLines) {
    const match = diagnosticLine(line);
    if (!match) continue;
    const [severityStr = '', filePath = '', lineStr = '', colStr = '', source = '', rest = ''] =
      match;
    const severity: DiagnosticSeverity =
      severityStr === 'Error' ? 1 : severityStr === 'Warn' ? 2 : severityStr === 'Hint' ? 4 : 3;

    let message = rest.trim();
    message = message.replace(/^\[\w+\]\s*/, '');
    message = message.replace(/^\([^)]*\)\s*/, '');

    const diag: LspDiagnostic = {
      file: filePath,
      line: Math.max(0, Number.parseInt(lineStr, 10) - 1),
      column: Math.max(0, Number.parseInt(colStr, 10) - 1),
      severity,
      message: message || `${severityStr} at ${lineStr}:${colStr}`,
      source: source || undefined,
    };
    const list = result[filePath] ?? [];
    list.push(diag);
    result[filePath] = list;
  }
  return result;
}
