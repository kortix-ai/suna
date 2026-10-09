import { useEffect, useRef, useState } from 'react';

/**
 * The text a copy or an export writes: every generative UI block replaced by
 * its markdown, never OpenUI source. The `@kortix/sdk/genui` barrel loads
 * `@openuidev/*` and `zod`, so it is a dynamic import: text without the word
 * "openui" returns unchanged and loads nothing, and the session chunk stays
 * light. Documented beside CANONICAL_SDK_ENTRIES (`scripts/sdk-boundary.mjs`).
 */
export async function genuiCopyText(text: string): Promise<string> {
  if (!mayHoldGenui(text)) return text;
  const { genuiToMarkdown } = await import('@kortix/sdk/genui');
  return genuiToMarkdown(text);
}

/**
 * True when `text` may hold a generative UI block, the only case `genuiCopyText`
 * changes. The regex mirrors the early return of `genuiToMarkdown` in
 * `packages/sdk/src/genui/markdown.ts`: keep the two identical.
 */
export function mayHoldGenui(text: string): boolean {
  return /openui/i.test(text);
}

/**
 * Copies `text` as markdown. The clipboard write starts inside the user gesture:
 * Safari rejects a write that starts after an await, so a block goes through a
 * `ClipboardItem` whose content resolves once the converter has loaded.
 */
export function copyGenuiText(text: string): Promise<void> {
  if (!mayHoldGenui(text)) return navigator.clipboard.writeText(text);
  if (typeof ClipboardItem !== 'undefined' && navigator.clipboard.write) {
    const blob = genuiCopyText(text).then((md) => new Blob([md], { type: 'text/plain' }));
    return navigator.clipboard.write([new ClipboardItem({ 'text/plain': blob })]);
  }
  return genuiCopyText(text).then((md) => navigator.clipboard.writeText(md));
}

/**
 * `raw` with every block converted to markdown, for a copy or download that must
 * be ready before the click. Text without a block is returned on the first render.
 * Text with a block is '' until the converter answers, so the caller keeps its
 * actions disabled and never writes OpenUI source. `onError` runs when the
 * converter fails to load; the result then stays ''.
 */
export function useGenuiCopyText(raw: string, onError: () => void): string {
  const [converted, setConverted] = useState<{ source: string; text: string } | null>(null);
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onErrorRef.current = onError;
  });
  useEffect(() => {
    if (!mayHoldGenui(raw)) return;
    let cancelled = false;
    genuiCopyText(raw).then(
      (text) => {
        if (!cancelled) setConverted({ source: raw, text });
      },
      () => {
        if (!cancelled) onErrorRef.current();
      },
    );
    return () => {
      cancelled = true;
    };
  }, [raw]);
  if (!mayHoldGenui(raw)) return raw;
  return converted?.source === raw ? converted.text : '';
}
