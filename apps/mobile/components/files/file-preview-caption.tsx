/**
 * The file sheet's caption section: a generated image's prompt and the model
 * that made it, under the image. Renders only when the file was opened with a
 * caption (the image card's open); every other file shows none.
 */
import { View } from 'react-native';

import { Text } from '@/components/ui/text';
import { MONO_FONT_FAMILY } from '@/lib/utils/mono-font';
import type { FileCaption } from '@/stores/tool-file-preview-store';

export function FilePreviewCaption({ caption }: { caption: FileCaption | undefined }) {
  if (!caption) return null;
  return (
    <View className="border-border gap-1 border-t px-4 py-3">
      <Text className="text-foreground text-sm">{caption.text}</Text>
      {caption.model ? (
        <Text className="text-muted-foreground text-xs" style={{ fontFamily: MONO_FONT_FAMILY }}>
          {caption.model}
        </Text>
      ) : null}
    </View>
  );
}
