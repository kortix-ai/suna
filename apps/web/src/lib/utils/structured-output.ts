/**
 * Structured output parser for tool output that contains warnings, tracebacks,
 * package installs, and other log-like content. Normalizes text that may have
 * lost its newlines and parses it into typed sections for rich UI rendering.
 */

export type OutputSection =
  | { type: 'warning'; text: string }
  | { type: 'error'; summary: string; errorType: string | null }
  | { type: 'traceback'; lines: string[] }
  | { type: 'info'; text: string }
  | { type: 'install'; text: string }
  | { type: 'plain'; text: string };

/**
 * Normalize tool output that may have had its newlines stripped or collapsed.
 * Inserts newlines before well-known markers so the parser can work line-by-line.
 * Also strips leftover ANSI caret artifacts (^[[...m sequences rendered as ^).
 */
export function normalizeToolOutput(raw: string): string {
  // Strip leftover caret-style ANSI artifacts like ^[[0m, ^[[1;31m, etc.
  let text = raw.replace(/\^+\[[\d;]*[A-Za-z]/g, '');
  // Also strip sequences of consecutive carets that are clearly artifacts
  text = text.replace(/\^{3,}/g, ' ');

  // If the text already has reasonable newlines, return as-is
  const lineCount = text.split('\n').length;
  if (lineCount > 5) return text;

  // Insert newlines before known section markers (no lookbehinds for compat)
  // Each pattern captures a char before the marker to avoid inserting at start of string
  text = text
    .replace(/(\S)\s*(warning:\s)/gi, '$1\n$2')
    .replace(/(\S)\s*(Traceback \(most recent call last\):)/g, '$1\n$2')
    .replace(/(\S)\s*(File ")/g, '$1\n$2')
    .replace(/(\S)\s*(Installed \d+ packages?\b)/gi, '$1\n$2')
    .replace(/(\S)\s*(Using (?:CPython|Python|Node|npm)\b)/gi, '$1\n$2')
    .replace(/(\S)\s*(Creating virtual environment\b)/gi, '$1\n$2')
    .replace(/(\S)\s*(raise\s+\w)/g, '$1\n$2')
    .replace(/(\))\s*(File ")/g, '$1\n$2');

  return text;
}

/**
 * Detect whether a raw output string contains structured log-like content
 * (warnings, tracebacks, package installs) that benefits from rich rendering.
 * Checks both multiline and inline patterns (for output that lost its newlines).
 */
export function hasStructuredContent(output: string): boolean {
  return (
    (/warning:/i.test(output) && /Traceback|Installed|Using|Creating|Error:/i.test(output)) ||
    /Traceback \(most recent call last\):/i.test(output)
  );
}

/**
 * Parse raw tool output into typed sections for rich rendering.
 * Handles Python warnings, tracebacks, package install summaries, and info lines.
 * Expects normalized output (call normalizeToolOutput first if needed).
 */
export function parseStructuredOutput(raw: string): OutputSection[] {
  const sections: OutputSection[] = [];
  const lines = raw.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trimStart();

    // Skip empty lines
    if (!trimmed) {
      i++;
      continue;
    }

    // --- Warning lines ---
    if (/^warning:/i.test(trimmed)) {
      // Collect continuation lines (indented or part of same warning)
      let warningText = trimmed;
      i++;
      while (i < lines.length) {
        const next = lines[i];
        const nextTrimmed = next.trimStart();
        // Continuation: indented or wrapped sentence that doesn't start a new section
        if (
          nextTrimmed &&
          !/^warning:/i.test(nextTrimmed) &&
          !/^(Traceback|Installed|Using|Creating|Error:|File ")/i.test(nextTrimmed) &&
          (next.startsWith('  ') || next.startsWith('\t') || /^[a-z]/.test(nextTrimmed))
        ) {
          warningText += ' ' + nextTrimmed;
          i++;
        } else {
          break;
        }
      }
      sections.push({ type: 'warning', text: warningText.replace(/^warning:\s*/i, '') });
      continue;
    }

    // --- Traceback block ---
    if (trimmed === 'Traceback (most recent call last):') {
      const traceLines: string[] = [trimmed];
      i++;
      // Collect all traceback lines until we hit the final error line
      while (i < lines.length) {
        const tl = lines[i];
        const tlTrimmed = tl.trimStart();
        traceLines.push(tl);
        i++;
        // The error line is the first non-indented, non-empty line after File/... lines
        if (
          tlTrimmed &&
          !tl.startsWith(' ') &&
          !tl.startsWith('\t') &&
          tlTrimmed !== 'Traceback (most recent call last):'
        ) {
          // This is the final error line — also check for multi-line error messages
          while (
            i < lines.length &&
            lines[i] &&
            (lines[i].startsWith(' ') || lines[i].startsWith('\t'))
          ) {
            traceLines.push(lines[i]);
            i++;
          }
          break;
        }
      }

      // Extract the final error line for summary
      const lastLine = traceLines[traceLines.length - 1]?.trim() || '';
      const typeMatch = lastLine.match(/^([\w._]+(?:Error|Exception|Warning)):\s*(.*)/);
      const errorType = typeMatch ? typeMatch[1].split('.').pop() || typeMatch[1] : null;
      const errorSummary = typeMatch ? typeMatch[2] || lastLine : lastLine;

      sections.push({ type: 'traceback', lines: traceLines });
      sections.push({ type: 'error', summary: errorSummary, errorType });
      continue;
    }

    // --- Package install summary ---
    if (/^Installed \d+ packages?\b/i.test(trimmed)) {
      sections.push({ type: 'install', text: trimmed });
      i++;
      continue;
    }

    // --- Info lines (Using, Creating, etc.) ---
    if (/^(Using|Creating) /i.test(trimmed)) {
      sections.push({ type: 'info', text: trimmed });
      i++;
      continue;
    }

    // --- Default: plain text ---
    // Collect consecutive plain lines
    const plainLines: string[] = [line];
    i++;
    while (i < lines.length) {
      const next = lines[i];
      const nextTrimmed = next.trimStart();
      if (
        !nextTrimmed ||
        /^(warning:|Traceback|Installed|Using|Creating|Error:)/i.test(nextTrimmed)
      ) {
        break;
      }
      plainLines.push(next);
      i++;
    }
    sections.push({ type: 'plain', text: plainLines.join('\n') });
  }

  return sections;
}
