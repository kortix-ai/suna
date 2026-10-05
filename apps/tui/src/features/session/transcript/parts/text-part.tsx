/**
 * An assistant/user text part.
 *
 * Rendered with OpenTUI's `<markdown>`, including while it streams.
 * Measured, not assumed — `apps/tui/scripts/dev-transcript.tsx --bench` runs
 * 321 incremental `content` assignments at 80 columns through the headless
 * renderer:
 *
 *   text      321 content updates in 2017ms → 6.28ms/update
 *   markdown  321 content updates in  985ms → 3.07ms/update
 *   text      321 content updates in 1829ms → 5.70ms/update
 *   markdown  321 content updates in  941ms → 2.93ms/update
 *
 * `<markdown>` is ~2x CHEAPER than a word-wrapped `<text>` of the same
 * content, so there is no in-flight fallback: one renderable, always. The
 * `streaming` flag is still passed while the turn is open — it keeps the
 * trailing block unstable so a half-written fence or table re-parses cleanly
 * once the turn finishes.
 *
 * `web-tree-sitter` is not installed in this workspace, so fenced code blocks
 * render unhighlighted. The structure (headings, lists, emphasis markers) is
 * concealed correctly regardless; verified in `transcript.test.tsx`.
 *
 * Trap — `<markdown>` paints NOTHING on its first frame. Its parse pass is
 * async, so a test that captures a frame straight after `flush()` reads an
 * empty content area. Verified: the same content is blank at 0 ms and correct
 * at 600 ms. `transcript.test.tsx` settles before every assertion.
 */

import { SyntaxStyle } from '@opentui/core';

import { theme } from '../../../../theme.ts';

/** One `SyntaxStyle` for the process. It owns a native handle — creating one
 *  per render would leak a handle per keystroke of a streaming turn. */
let syntaxStyleSingleton: SyntaxStyle | null = null;

export function transcriptSyntaxStyle(): SyntaxStyle {
  if (!syntaxStyleSingleton) syntaxStyleSingleton = SyntaxStyle.create();
  return syntaxStyleSingleton;
}

export interface TextPartProps {
  text: string;
  /** True while this part is the tail of a turn that is still running. */
  streaming: boolean;
  width: number;
}

export function TextPart({ text, streaming, width }: TextPartProps) {
  return (
    <markdown
      content={text}
      syntaxStyle={transcriptSyntaxStyle()}
      streaming={streaming}
      fg={theme.fg}
      width={Math.max(width, 1)}
    />
  );
}
