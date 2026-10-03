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
 * Each tile is memoized and reads its own progress (`live`), so a progress
 * tick re-renders one tile, and a keystroke in the composer re-renders none.
 */

import * as React from 'react';
import { ScrollView, View } from 'react-native';
import type { AttachedFile } from '@/lib/session/attachments';
import { isPreviewableImage } from '@/lib/session/attachment-tile';
import { webSpace } from '@/lib/session/user-message';
import {
  AttachmentFailureScrim,
  AttachmentRemoveButton,
  AttachmentTile,
  UploadProgressRing,
} from './attachment-tile';

/** Per-file upload state, keyed by the file's index in `files`. */
export interface ComposerAttachmentUpload {
  /** 0–100 while uploading. */
  progress?: number;
  failed?: boolean;
  /** Present when a retry can succeed. */
  onRetry?: () => void;
  /**
   * The live progress of an upload in flight. The tile subscribes itself, so
   * progress ticks do not re-render the composer. `progress` is the value at
   * the time the entry was built.
   */
  live?: {
    subscribe: (listener: () => void) => () => void;
    getProgress: () => number | undefined;
  };
}

const NO_SUBSCRIBE = () => () => {};

/** Room for the remove dot, which sits `webSpace(1.5)` outside each tile. */
const DOT_OVERHANG = webSpace(1.5);

export function ComposerAttachmentTiles({
  files,
  onRemove,
  uploads,
  disabled,
  contentPaddingHorizontal = 0,
}: {
  files: AttachedFile[];
  onRemove: (index: number) => void;
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
  if (files.length === 0) return null;
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
    <View style={{ position: 'relative' }}>
      <AttachmentTile
        filename={file.name}
        mime={file.mimeType}
        imageSource={image ? { uri: file.uri } : undefined}
        corner={running ? <UploadProgressRing value={progress} /> : undefined}
        overlay={failed ? <AttachmentFailureScrim filename={file.name} onRetry={upload?.onRetry} /> : undefined}
      />
      <AttachmentRemoveButton filename={file.name} disabled={disabled} onRemove={() => onRemove(index)} />
    </View>
  );
});
