/**
 * optimistic-parts — the parts of an optimistic user message: the text part
 * (none for blank text), then one file part per picked file carrying its
 * device URI, so the bubble shows the local thumbnail until the server echo
 * replaces the message. Shared by a thread send (`SessionPage` `handleSend`)
 * and a project-home send's seed (`first-prompt-seed.ts`).
 *
 * Ids use the `prt_` prefix: `addOptimisticMessage` registers each one and
 * `upsertPart` drops exactly those when the real parts land. Pure, so
 * `bun test` runs it.
 */
import type { Part } from '../opencode/types';
import type { AttachedFile } from './attachments';

/** `text` is used as given; the caller trims it if it wants to. */
export function optimisticUserParts(text: string, files: readonly AttachedFile[], nowMs: number): Part[] {
  let n = 0;
  const partId = () => `prt_${nowMs}_${n++}_${Math.random().toString(36).slice(2, 8)}`;
  const parts: Part[] = text.trim() ? [{ type: 'text', id: partId(), text }] : [];
  for (const file of files) {
    parts.push({
      type: 'file',
      id: partId(),
      mime: file.mimeType,
      filename: file.name,
      url: undefined,
      localUri: file.uri,
    });
  }
  return parts;
}
