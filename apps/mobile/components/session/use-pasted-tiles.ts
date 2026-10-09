/**
 * usePastedTiles — one composer's "Pasted text" tiles. Used by
 * `SessionChatInput` (a thread) and `ProjectHome` (a new session).
 *
 * `takePaste(prev, next)` runs in the field's change handler, and
 * `onSelectionChange` on the field, so the paste is cut at the selection it
 * replaced (`extractPastedInsertion`): a long paste leaves the field and
 * becomes a tile, and the handler keeps the text it returns. A paste that would push the prompt past
 * `PASTED_INLINE_MAX_BYTES` goes out as a plain-text file instead
 * (`pasted-text-<n>.txt`, through the composer's file upload).
 *
 * Tiles are not part of the saved draft: mobile drafts stay text-only.
 */
import * as React from 'react';
import type { NativeSyntheticEvent, TextInputSelectionChangeEventData } from 'react-native';
import {
  PASTED_INLINE_MAX_BYTES,
  newPastedContentId,
  serializePromptWithPastes,
  utf8Bytes,
  type PastedContent,
} from '@kortix/shared';

import { log } from '@/lib/logger';
import type { AttachedFile } from '@/lib/session/attachments';
import { extractPastedInsertion, type TextSelection } from '@/lib/session/paste-tiles';

/** Writes the paste to the cache. The upload reads it from there like a picked file. */
function writePastedTextFile(text: string, n: number): AttachedFile {
  // Lazy: the native module is absent under bun, and only an oversized paste needs it.
  const { File, Paths } = require('expo-file-system') as typeof import('expo-file-system');
  const file = new File(Paths.cache, `pasted-text-${newPastedContentId()}.txt`);
  file.create({ overwrite: true });
  file.write(text);
  return { uri: file.uri, name: `pasted-text-${n}.txt`, mimeType: 'text/plain', size: utf8Bytes(text), isImage: false };
}

export function usePastedTiles(addFile: (files: AttachedFile[]) => void, initial?: PastedContent[]) {
  const [pastes, setPastes] = React.useState<PastedContent[]>(() => initial ?? []);
  // Two pastes inside one render both see the first.
  const pastesRef = React.useRef(pastes);
  pastesRef.current = pastes;
  const fileCountRef = React.useRef(0);
  // The last selection the field reported. At a change it is still the one from before it.
  const selectionRef = React.useRef<TextSelection | null>(null);
  const onSelectionChange = React.useCallback(
    (e: NativeSyntheticEvent<TextInputSelectionChangeEventData>) => {
      selectionRef.current = e.nativeEvent.selection;
    },
    [],
  );

  const update = React.useCallback((next: PastedContent[]) => {
    pastesRef.current = next;
    setPastes(next);
  }, []);

  /** The text the field keeps after it changed from `prev` to `next`. */
  const takePaste = React.useCallback(
    (prev: string, next: string): string => {
      const hit = extractPastedInsertion(prev, next, selectionRef.current);
      if (!hit) return next;
      // The field changes under the caret; the next selection event says where it is.
      selectionRef.current = null;
      const paste = { id: newPastedContentId(), text: hit.paste };
      const all = [...pastesRef.current, paste];
      if (utf8Bytes(serializePromptWithPastes(hit.text, all)) > PASTED_INLINE_MAX_BYTES) {
        try {
          fileCountRef.current += 1;
          addFile([writePastedTextFile(hit.paste, fileCountRef.current)]);
          return hit.text;
        } catch (err) {
          // No cache file: the paste stays a tile and the send carries it inline.
          log.warn('[paste] could not write the pasted text to a file:', err);
        }
      }
      update(all);
      return hit.text;
    },
    [addFile, update],
  );

  const remove = React.useCallback(
    (id: string) => update(pastesRef.current.filter((p) => p.id !== id)),
    [update],
  );
  const clear = React.useCallback(() => {
    if (pastesRef.current.length > 0) update([]);
  }, [update]);

  /** The tiles now, also inside a change handler that just added one. */
  const getPastes = React.useCallback(() => pastesRef.current, []);

  return { pastes, takePaste, onSelectionChange, getPastes, remove, clear };
}
