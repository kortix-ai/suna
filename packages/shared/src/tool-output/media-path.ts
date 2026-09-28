import { indexOfIgnoreCase } from '../tag-blocks';
import { isWhitespace } from './scan';

// Image and video tools print a path, a quoted path, or prose around one. The
// renderers read it with two regexes. `/^["']+|["']+$/g` retried a quote run
// from every position inside it: 240k quotes inside the output took 22 s. The
// path regex rescanned the rest of a path-like run for every sandbox root in
// it: 48k `/tmp/` took 6.6 s. The readers here return what the regexes did.

const QUOTE = 34; // "
const APOSTROPHE = 39; // '
const DOT = 46; // .

/** Extensions in the regexes' alternation order: `png|jpe?g|…` tries `jpeg` before `jpg`. */
const EXTENSIONS = {
  image: ['png', 'jpeg', 'jpg', 'gif', 'webp', 'svg', 'bmp', 'ico'],
  video: ['mp4', 'webm', 'mov', 'avi', 'mkv', 'm4v', 'ogv'],
} as const;

const isQuote = (code: number) => code === QUOTE || code === APOSTROPHE;

/** The text without its leading and trailing quotes, as `text.replace(/^["']+|["']+$/g, '')`. */
export function withoutEdgeQuotes(text: string): string {
  let start = 0;
  while (start < text.length && isQuote(text.charCodeAt(start))) start++;
  let end = text.length;
  while (end > start && isQuote(text.charCodeAt(end - 1))) end--;
  return text.slice(start, end);
}

/** The extension that `\.(?:…)` matches at the dot at `at`, ignoring ASCII case, or null. */
function extensionAt(text: string, at: number, kind: 'image' | 'video'): string | null {
  if (text.charCodeAt(at) !== DOT) return null;
  for (const extension of EXTENSIONS[kind]) {
    if (indexOfIgnoreCase(text.slice(at + 1, at + 1 + extension.length), extension) === 0)
      return extension;
  }
  return null;
}

/**
 * The first sandbox image or video path in the text, as
 * `new RegExp(`(?:${roots.join('|')})/[^\s"']+\.(?:ext…)`, 'i')` matched it:
 * a root, `/`, and the run of characters that are not whitespace or quotes, up
 * to the last extension in that run.
 */
export function sandboxMediaPath(
  text: string,
  roots: readonly string[],
  kind: 'image' | 'video',
): string | null {
  // The run's end and the end of its last extension, for the run last measured:
  // every root inside one run reaches the same run end.
  let measuredFrom = -1;
  let runEnd = -1;
  let lastDot = -1;
  let lastEnd = -1;
  // The next occurrence of each root, ignoring ASCII case.
  const next = roots.map((root) => indexOfIgnoreCase(text, root, 0));
  for (;;) {
    let start = -1;
    for (const at of next) if (at !== -1 && (start === -1 || at < start)) start = at;
    if (start === -1) return null;
    // Roots in the regex's alternation order, at this position.
    for (const [index, root] of roots.entries()) {
      if (next[index] !== start) continue;
      const slash = start + root.length;
      if (text.charCodeAt(slash) !== 47) continue;
      const runStart = slash + 1;
      if (runStart < measuredFrom || runStart >= runEnd) {
        // Measure the run that `runStart` is in, and find its last extension.
        let end = runStart;
        while (end < text.length) {
          const code = text.charCodeAt(end);
          if (isWhitespace(code) || isQuote(code)) break;
          end++;
        }
        measuredFrom = runStart;
        runEnd = end;
        lastDot = -1;
        lastEnd = -1;
        for (
          let dot = text.lastIndexOf('.', end - 1);
          dot >= runStart;
          dot = dot > 0 ? text.lastIndexOf('.', dot - 1) : -1
        ) {
          const extension = extensionAt(text, dot, kind);
          if (extension) {
            lastDot = dot;
            lastEnd = dot + 1 + extension.length;
            break;
          }
        }
      }
      // `[^\s"']+` takes at least one character before the dot. The last
      // extension of the run is the last one after this root too, if any is.
      if (lastDot >= runStart + 1) return text.slice(start, lastEnd);
    }
    // Look for each root again after this position.
    for (const [index, root] of roots.entries()) {
      if (next[index] !== -1 && (next[index] as number) <= start)
        next[index] = indexOfIgnoreCase(text, root, start + 1);
    }
  }
}

/**
 * The path without its trailing slashes, as `path.replace(/\/+$/, '')`. The
 * regex retried a slash run from every slash in it: 240k slashes inside a path
 * took seconds.
 */
export function withoutTrailingSlashes(path: string): string {
  let end = path.length;
  while (end > 0 && path.charCodeAt(end - 1) === 47) end--;
  return path.slice(0, end);
}
