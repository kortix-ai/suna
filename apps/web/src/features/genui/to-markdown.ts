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

/** True when `text` may hold a generative UI block, the only case `genuiCopyText` changes. */
export function mayHoldGenui(text: string): boolean {
  return /openui/i.test(text);
}
