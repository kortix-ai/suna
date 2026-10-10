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

/** One block as markdown, for a host that cannot render it (`GenuiFenceBoundary`). Same lazy barrel. */
export async function genuiBlockText(code: string, version: number, options: { streaming: boolean }): Promise<string> {
  const { genuiBlockToMarkdown } = await import('@kortix/sdk/genui');
  return genuiBlockToMarkdown(code, version, options);
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

interface CopyPart {
  type: string;
  text?: string;
}

const holdsGenui = (message: { parts: CopyPart[] }) =>
  message.parts.some((part) => part.type === 'text' && mayHoldGenui(part.text ?? ''));

/**
 * `messages` with every text part's blocks converted to markdown, each part on its own: a fence one
 * message never closed ends with that message. Converted as one transcript string, it ran on into
 * the next turn and took that turn with it. Same lazy barrel as `genuiCopyText`.
 */
export async function genuiCopyMessages<M extends { parts: CopyPart[] }>(messages: M[]): Promise<M[]> {
  if (!messages.some(holdsGenui)) return messages;
  const { genuiToMarkdown } = await import('@kortix/sdk/genui');
  const convert = (part: CopyPart) =>
    part.type === 'text' && part.text && mayHoldGenui(part.text) ? { ...part, text: genuiToMarkdown(part.text) } : part;
  return messages.map((message) => (holdsGenui(message) ? { ...message, parts: message.parts.map(convert) } : message));
}

/**
 * `messages` converted by `genuiCopyMessages`, for a copy or download that must be ready before the
 * click. Messages without a block are returned on the first render. Messages with a block are null
 * until the converter answers, so the caller keeps its actions disabled and never writes OpenUI
 * source. `onError` runs when the converter fails to load; the result then stays null.
 */
export function useGenuiCopyMessages<M extends { parts: CopyPart[] }>(messages: M[], onError: () => void): M[] | null {
  const [converted, setConverted] = useState<{ source: M[]; result: M[] } | null>(null);
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onErrorRef.current = onError;
  });
  const needed = messages.some(holdsGenui);
  useEffect(() => {
    if (!needed) return;
    let cancelled = false;
    genuiCopyMessages(messages).then(
      (result) => {
        if (!cancelled) setConverted({ source: messages, result });
      },
      () => {
        if (!cancelled) onErrorRef.current();
      },
    );
    return () => {
      cancelled = true;
    };
  }, [messages, needed]);
  if (!needed) return messages;
  return converted?.source === messages ? converted.result : null;
}
