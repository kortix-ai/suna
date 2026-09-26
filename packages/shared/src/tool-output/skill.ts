import { removeSpans, tagBlocks } from '../tag-blocks';
import { lineEnd } from './scan';

const NOTE = 'Note:';
const PHRASE = 'relative to the base directory';

/**
 * The text without its first `Note: … relative to the base directory …` line
 * tail, as `text.replace(/Note:.*relative to the base directory.*$/m, '')`
 * returned it. The regex rescanned the rest of the line for every `Note:`:
 * 48k of them on one line took 4.6 s.
 */
function withoutBaseDirectoryNote(text: string): string {
  let from = 0;
  // The next phrase at or after the last position it was searched from.
  let nextPhrase = -2;
  for (;;) {
    const note = text.indexOf(NOTE, from);
    if (note === -1) return text;
    const end = lineEnd(text, note);
    if (nextPhrase < note + NOTE.length) nextPhrase = text.indexOf(PHRASE, note + NOTE.length);
    // No phrase after this note means none after a later note either.
    if (nextPhrase === -1) return text;
    // The phrase has no line terminator, so one that starts on the line ends on it.
    if (nextPhrase < end) return text.slice(0, note) + text.slice(end);
    // A later note on the same line has less of the line after it: it fails too.
    from = end;
  }
}

/**
 * A skill tool's `<skill_content>` as the document to show: without the file
 * listing, the `Base directory:` line, and the runtime note about relative
 * paths. Returns what the renderers' regex chain returned.
 */
export function skillDocumentBody(skillContent: string): string {
  const text = skillContent.trimStart();
  const withoutFiles = removeSpans(text, tagBlocks(text, 'skill_files', { limit: 1 }));
  // Linear: the first `Base directory:` always matches, to the end of its line.
  return withoutBaseDirectoryNote(withoutFiles.replace(/Base directory:.*$/m, '')).trim();
}
