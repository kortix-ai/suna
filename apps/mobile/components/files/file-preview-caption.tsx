/**
 * The file sheet's caption section: a generated image's prompt and the model
 * that made it, under the image. Renders only when the file was opened with a
 * caption (the image card's open); every other file shows none. A long
 * prompt scrolls inside the section (web `max-h-32`), so the image keeps its room.
 */

import { ScrollView } from 'react-native';

import { Text } from '@/components/ui/text';
import { webSpace } from '@/lib/session/user-message';
import { MONO_FONT_FAMILY } from '@/lib/utils/mono-font';
import type { FileCaption } from '@/stores/tool-file-preview-store';

/** Web's `max-h-32`. */
const MAX_HEIGHT = webSpace(32);

export function FilePreviewCaption({ caption }: { caption: FileCaption | undefined }) {
  if (!caption) return null;
  return (
    <ScrollView
      className="border-border border-t"
      style={{ maxHeight: MAX_HEIGHT, flexGrow: 0 }}
      contentContainerClassName="gap-1 px-4 py-3">
      <Text className="text-foreground text-sm">{caption.text}</Text>
      {caption.model ? (
        <Text className="text-muted-foreground text-xs" style={{ fontFamily: MONO_FONT_FAMILY }}>
          {caption.model}
        </Text>
      ) : null}
    </ScrollView>
  );
}
