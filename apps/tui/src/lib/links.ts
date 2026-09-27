/**
 * Find the URLs in text a session produced, so a terminal that cannot be
 * clicked can still open them.
 *
 * Why this exists: the terminal panel is a VT emulator drawn into cells. A
 * long URL — an OAuth sign-in link a CLI prints — wraps across rows, and the
 * host terminal (Ghostty, iTerm2) only detects a link inside ONE of its own
 * rows, so it can never be clicked or Cmd+clicked. The Links panel (`Alt+L`)
 * lists what this file finds, and Enter opens it in the browser.
 *
 * Two sources feed it:
 *  - transcript text and tool output — newline-separated prose, scanned as is;
 *  - the terminal SCREEN (`EmbeddedTerminalRenderable.screen().lines`) — rows
 *    of a fixed width, where a row filled to its last column continues on the
 *    next one. `joinWrappedRows` rebuilds those before the scan.
 */

/** `http(s)://` up to the first whitespace, quote, angle bracket or control character. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: a screen row can carry raw control bytes; a URL never does.
const URL_REGEX = /https?:\/\/[^\s<>"'`\u0000-\u001f\u007f]+/g;

/**
 * Characters a sentence hangs on the end of a URL — `(see https://x.dev).` —
 * that are almost never part of it. A closing bracket is dropped only when the
 * URL has no matching opening one (Wikipedia-style `…/Foo_(bar)` keeps its).
 */
const TRAILING = /[.,;:!?'"]+$/;

function stripTrailing(url: string): string {
  let out = url.replace(TRAILING, '');
  for (;;) {
    const last = out.at(-1);
    if (last === ')' && (out.match(/\(/g)?.length ?? 0) < (out.match(/\)/g)?.length ?? 0)) {
      out = out.slice(0, -1).replace(TRAILING, '');
      continue;
    }
    if (last === ']' && (out.match(/\[/g)?.length ?? 0) < (out.match(/]/g)?.length ?? 0)) {
      out = out.slice(0, -1).replace(TRAILING, '');
      continue;
    }
    if (last === '}' && (out.match(/{/g)?.length ?? 0) < (out.match(/}/g)?.length ?? 0)) {
      out = out.slice(0, -1).replace(TRAILING, '');
      continue;
    }
    return out;
  }
}

/** Every http(s) URL in `text`, in order of first appearance, deduplicated. */
export function extractUrls(text: string): string[] {
  if (!text) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of text.matchAll(URL_REGEX)) {
    const url = stripTrailing(match[0]);
    if (url.length <= 'https://'.length) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

/**
 * Rebuild lines the emulator soft-wrapped.
 *
 * A row whose last cell is a non-space at `columns - 1` is treated as
 * continuing on the next row, and the two are joined with NO separator: that
 * is where a URL longer than the panel breaks. Every other row ends a line.
 * Rows come from `screen().lines`, which may or may not be right-padded with
 * spaces; both shapes are handled.
 */
export function joinWrappedRows(lines: readonly string[], columns: number): string {
  const out: string[] = [];
  let current = '';
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    current += line;
    const filled = columns > 0 && line.length >= columns;
    if (!filled) {
      out.push(current);
      current = '';
    }
  }
  if (current) out.push(current);
  return out.join('\n');
}

/** URLs on a terminal screen, wrapped rows rejoined first. */
export function extractUrlsFromScreen(lines: readonly string[], columns: number): string[] {
  return extractUrls(joinWrappedRows(lines, columns));
}
