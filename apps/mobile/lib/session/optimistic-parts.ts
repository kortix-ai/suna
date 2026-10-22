/**
 * optimistic-parts — the parts of an optimistic user message: the text part
 * (none for blank text), then one file part per picked file carrying its
 * device URI, so the bubble shows the local thumbnail until the server echo
 * replaces the message. Shared by a thread send (`SessionPage` `handleSend`)
 * and a project-home send's seed (`first-prompt-seed.ts`).
 *
 * Ids use the `prt_` prefix. The SDK's session store drops these parts when
 * the echo's real parts land. The device URI is kept by part id
 * (`localUriOf`), so the bubble's attachment block finds its thumbnail.
 */
import type { AttachedFile } from './attachments';
import type { OptimisticPart } from './session-store';

/** The picked file behind each optimistic attachment, by part id (= the block id the bubble reads). */
// ponytail: never pruned; one short entry per picked file in this app run.
const localUris = new Map<string, string>();

/** The device URI of the picked file an optimistic attachment was made from, if any. */
export function localUriOf(partId: string): string | undefined {
  return localUris.get(partId);
}

/**
 * `text` is used as given; the caller trims it if it wants to. The parts carry
 * no `sessionID`/`messageID`: `addOptimisticMessage` (session-store.ts) stamps
 * them with the message they join.
 */
export function optimisticUserParts(text: string, files: readonly AttachedFile[], nowMs: number): OptimisticPart[] {
  let n = 0;
  const partId = () => `prt_${nowMs}_${n++}_${Math.random().toString(36).slice(2, 8)}`;
  const parts: OptimisticPart[] = text.trim() ? [{ type: 'text', id: partId(), text }] : [];
  for (const file of files) {
    const id = partId();
    localUris.set(id, file.uri);
    parts.push({ type: 'file', id, mime: file.mimeType, filename: file.name, url: undefined, localUri: file.uri });
  }
  return parts;
}
