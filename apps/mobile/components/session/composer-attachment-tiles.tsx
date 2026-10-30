/**
 * ComposerAttachmentTiles — the picked files in a composer, drawn with the SAME
 * `AttachmentTile` the sent message uses, plus what an unsent file needs: a
 * corner remove dot, an upload progress ring, and a failure scrim.
 *
 * Mirrors apps/web `features/session/composer/attachment-tiles.tsx`, with one
 * layout difference: web wraps the tiles (`flex flex-wrap gap-2`); on a phone
 * the row scrolls horizontally so the composer does not grow a 103px row per
 * three files. Used by `SessionChatInput` and `components/kortix/composer.tsx`.
 *
 * Pasted text (`pastes`, `use-pasted-tiles.ts`) draws first, as the same tile
 * with a text preview and a `PASTED` badge. Pressing one opens it (`onOpenPaste`).
 *
 * Each tile is memoized and reads its own progress (`live`), so a progress
 * tick re-renders one tile, and a keystroke in the composer re-renders none.
 */

import * as React from 'react';
import { ScrollView, View } from 'react-native';
import type { PastedContent } from '@kortix/shared';
import type { AttachedFile } from '@/lib/session/attachments';
import { isPreviewableImage } from '@/lib/session/attachment-tile';
import type { ComposerAttachmentUpload } from '@/lib/session/composer-uploads';
import { webSpace } from '@/lib/session/user-message';
import {
  AttachmentFailureScrim,
  AttachmentTile,
  RemovableAttachmentTile,
  UploadProgressRing,
} from './attachment-tile';

const NO_SUBSCRIBE = () => () => {};
const NO_PASTES: PastedContent[] = [];

/** Room for the remove dot, which sits `webSpace(1.5)` outside each tile. */
const DOT_OVERHANG = webSpace(1.5);

export function ComposerAttachmentTiles({
  files,
  onRemove,
  pastes = NO_PASTES,
  onRemovePaste,
  onOpenPaste,
  uploads,
  disabled,
  contentPaddingHorizontal = 0,
}: {
  files: AttachedFile[];
  onRemove: (index: number) => void;
  pastes?: PastedContent[];
  onRemovePaste?: (id: string) => void;
  onOpenPaste?: (paste: PastedContent) => void;
  uploads?: Readonly<Record<number, ComposerAttachmentUpload>>;
  disabled?: boolean;
  /** Aligns the first tile with the composer's text. */
  contentPaddingHorizontal?: number;
}) {
  // `composer.tsx` passes a new `onRemove` each render; the tiles get one
  // stable function that calls the latest.
  const onRemoveRef = React.useRef(onRemove);
  onRemoveRef.current = onRemove;
  const remove = React.useCallback((index: number) => onRemoveRef.current(index), []);
  const pasteHandlersRef = React.useRef({ onRemovePaste, onOpenPaste });
  pasteHandlersRef.current = { onRemovePaste, onOpenPaste };
  const removePaste = React.useCallback((id: string) => pasteHandlersRef.current.onRemovePaste?.(id), []);
  const openPaste = React.useCallback((paste: PastedContent) => pasteHandlersRef.current.onOpenPaste?.(paste), []);
  if (files.length === 0 && pastes.length === 0) return null;
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      className="flex-grow-0"
      contentContainerStyle={{
        gap: webSpace(2),
        paddingTop: DOT_OVERHANG,
        paddingRight: DOT_OVERHANG + contentPaddingHorizontal,
        paddingLeft: contentPaddingHorizontal,
      }}
    >
      {pastes.map((paste) => (
        <PastedTextTile
          key={paste.id}
          paste={paste}
          disabled={disabled}
          onOpen={onOpenPaste ? openPaste : undefined}
          onRemove={removePaste}
        />
      ))}
      {files.map((file, index) => (
        <ComposerAttachmentTile
          key={`${file.uri}-${index}`}
          file={file}
          index={index}
          upload={uploads?.[index]}
          disabled={disabled}
          onRemove={remove}
        />
      ))}
    </ScrollView>
  );
}

const ComposerAttachmentTile = React.memo(function ComposerAttachmentTile({
  file,
  index,
  upload,
  disabled,
  onRemove,
}: {
  file: AttachedFile;
  index: number;
  upload: ComposerAttachmentUpload | undefined;
  disabled?: boolean;
  onRemove: (index: number) => void;
}) {
  const live = upload?.live;
  const liveProgress = React.useSyncExternalStore(live?.subscribe ?? NO_SUBSCRIBE, () =>
    live ? live.getProgress() : upload?.progress,
  );
  const progress = live ? liveProgress : upload?.progress;
  const failed = Boolean(upload?.failed);
  const running = !failed && typeof progress === 'number' && progress < 100;
  const image = file.isImage && isPreviewableImage(file.name, file.mimeType);
  return (
    <RemovableAttachmentTile filename={file.name} disabled={disabled} onRemove={() => onRemove(index)}>
      <AttachmentTile
        filename={file.name}
        mime={file.mimeType}
        imageSource={image ? { uri: file.uri } : undefined}
        corner={running ? <UploadProgressRing value={progress} /> : undefined}
        overlay={failed ? <AttachmentFailureScrim filename={file.name} onRetry={upload?.onRetry} /> : undefined}
      />
    </RemovableAttachmentTile>
  );
});

const PastedTextTile = React.memo(function PastedTextTile({
  paste,
  disabled,
  onOpen,
  onRemove,
}: {
  paste: PastedContent;
  disabled?: boolean;
  onOpen?: (paste: PastedContent) => void;
  onRemove: (id: string) => void;
}) {
  return (
    <RemovableAttachmentTile filename="pasted text" disabled={disabled} onRemove={() => onRemove(paste.id)}>
      <AttachmentTile
        filename="Pasted text"
        preview={paste.text}
        onPress={onOpen ? () => onOpen(paste) : undefined}
        accessibilityLabel="Pasted text"
      />
    </RemovableAttachmentTile>
  );
});
