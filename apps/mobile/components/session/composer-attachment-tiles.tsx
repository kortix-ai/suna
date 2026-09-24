/**
 * ComposerAttachmentTiles — the picked files in a composer, drawn with the SAME
 * `AttachmentTile` the sent message uses, plus what an unsent file needs: a
 * corner remove dot, an upload progress ring, and a failure scrim.
 *
 * Mirrors apps/web `features/session/composer/attachment-tiles.tsx`, with one
 * layout difference: web wraps the tiles (`flex flex-wrap gap-2`); on a phone
 * the row scrolls horizontally so the composer does not grow a 103px row per
 * three files. Used by `SessionChatInput` and `components/kortix/composer.tsx`.
 */

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
}

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
      {files.map((file, index) => {
        const upload = uploads?.[index];
        const failed = Boolean(upload?.failed);
        const running = !failed && typeof upload?.progress === 'number' && upload.progress < 100;
        const image = file.isImage && isPreviewableImage(file.name, file.mimeType);
        return (
          <View key={`${file.uri}-${index}`} style={{ position: 'relative' }}>
            <AttachmentTile
              filename={file.name}
              mime={file.mimeType}
              imageSource={image ? { uri: file.uri } : undefined}
              corner={running ? <UploadProgressRing value={upload!.progress!} /> : undefined}
              overlay={
                failed ? <AttachmentFailureScrim filename={file.name} onRetry={upload?.onRetry} /> : undefined
              }
            />
            <AttachmentRemoveButton
              filename={file.name}
              disabled={disabled}
              onRemove={() => onRemove(index)}
            />
          </View>
        );
      })}
    </ScrollView>
  );
}
