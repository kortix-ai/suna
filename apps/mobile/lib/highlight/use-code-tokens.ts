import { useEffect, useMemo, useState } from 'react';

import {
  highlightToTokens,
  highlightToTokensAsync,
  peekTokens,
  plainTokens,
  SYNC_HIGHLIGHT_LENGTH,
  type CodeLine,
  type CodeScheme,
} from './shiki';

export interface CodeTokensResult {
  lines: CodeLine[];
  /** False while `lines` is the plain placeholder (streaming, or highlight pending). */
  highlighted: boolean;
}

/**
 * Highlighted lines for a code block.
 *
 * - `enabled: false` (a fence still streaming) returns plain lines in the
 *   theme's base colour and does no highlighting work. Flip it to `true` once
 *   the block is complete; the block is then tokenized once per
 *   (code, language, scheme) and memoized.
 * - A block up to `SYNC_HIGHLIGHT_LENGTH` characters whose grammar is already
 *   loaded highlights in the first render, so it never flashes plain.
 * - Anything else renders plain first and swaps to colour when the grammar has
 *   loaded and the sliced tokenizer has finished, without holding the JS
 *   thread for the whole block.
 */
export function useCodeTokens(
  code: string,
  language: string,
  scheme: CodeScheme,
  { enabled = true }: { enabled?: boolean } = {},
): CodeTokensResult {
  const key = `${scheme}:${language}:${code}`;
  const [done, setDone] = useState<{ key: string; lines: CodeLine[] } | null>(null);

  const immediate = useMemo(() => {
    if (!enabled) return null;
    return code.length <= SYNC_HIGHLIGHT_LENGTH
      ? highlightToTokens(code, language, scheme)
      : peekTokens(code, language, scheme);
  }, [code, enabled, language, scheme]);

  const plain = useMemo(
    () => (immediate ? null : plainTokens(code, scheme)),
    [code, immediate, scheme],
  );

  useEffect(() => {
    if (!enabled || immediate) return;
    let alive = true;
    void highlightToTokensAsync(code, language, scheme).then((lines) => {
      if (alive) setDone({ key, lines });
    });
    return () => {
      alive = false;
    };
  }, [code, enabled, immediate, key, language, scheme]);

  if (immediate) return { lines: immediate, highlighted: true };
  if (enabled && done?.key === key) return { lines: done.lines, highlighted: true };
  return { lines: plain!, highlighted: false };
}
