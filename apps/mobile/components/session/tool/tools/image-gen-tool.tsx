/**
 * `image-gen`. Port of apps/web `tool/tools/image-gen-tool.tsx`:
 * - trigger: `Image` · the action title ("Generate Image", "Edit Image",
 *   "Upscale Image", "Remove Background", else "Image Gen") · the first 60
 *   characters of the prompt;
 * - body: a found image → a `ToolResultCard` (`p-1`) holding the image
 *   (`max-h-64`, `rounded-sm`, contain), "Loading image preview..." shimmer
 *   while it loads, or the path in mono when it cannot load; no image → the
 *   output through `ToolOutputFallback`.
 *
 * Differences from web: a sandbox image loads through `useSandboxImage` (the
 * native loader with an auth header; above the size limit it waits for a
 * tap), not a base64 read. Tapping the image opens it full screen: a sandbox
 * file in the app's file sheet, a direct URL in the browser.
 */

import { useMemo } from 'react';
import { Image, Pressable, View } from 'react-native';
import { TextShimmer } from '@/components/kortix/text-shimmer';
import { useSandboxImage } from '@/components/session/turn/use-sandbox-image';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { ImageIcon } from '@/lib/icons';
import { disclosureKey } from '@/lib/session/disclosure-store';
import { formatMegabytes } from '@/lib/session/image-load';
import { imageGenTitle, parseImageOutput } from '@/lib/session/tools/web-media';
import { safeHttpUrl } from '@/lib/session/tools/web-fetch';
import { webSpace } from '@/lib/session/user-message';
import {
  BasicTool,
  ToolOutputFallback,
  isLocalSandboxFilePath,
  partInput,
  partOutput,
  useToolNavigation,
} from '../shared/infrastructure';
import { ToolRegistry } from '../shared/registry';
import { ToolResultCard } from '../shared/result-card';
import { TURN_SPACE, TURN_TYPE, monoFont, useTurnPalette } from '../shared/styles';
import type { ToolProps } from '../shared/types';

/** Web `max-h-64`. */
const IMAGE_MAX_HEIGHT = webSpace(64);

function GeneratedImage({ uri, headers, label, onPress, onError, imageKey }: {
  uri: string;
  headers?: Record<string, string>;
  label: string;
  onPress: () => void;
  onError?: () => void;
  imageKey?: number;
}) {
  return (
    <Pressable accessibilityRole="imagebutton" accessibilityLabel={label} onPress={onPress}>
      <Image
        key={imageKey}
        source={{ uri, headers }}
        onError={onError}
        resizeMode="contain"
        resizeMethod="resize"
        style={{ width: '100%', height: IMAGE_MAX_HEIGHT, borderRadius: TURN_SPACE.radiusSm }}
      />
    </Pressable>
  );
}

export function ImageGenTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const palette = useTurnPalette();
  const { openFile, openExternal } = useToolNavigation();
  const input = partInput(part);
  const output = partOutput(part);
  const prompt = typeof input.prompt === 'string' ? input.prompt : undefined;
  const action = typeof input.action === 'string' ? input.action : undefined;

  const { imagePath, directUrl } = useMemo(() => parseImageOutput(output), [output]);
  const safeDirectUrl = useMemo(() => safeHttpUrl(directUrl), [directUrl]);
  const sandboxPath = imagePath && isLocalSandboxFilePath(imagePath) && !directUrl ? imagePath : '';
  const image = useSandboxImage(sandboxPath, Boolean(sandboxPath));
  const label = prompt || 'Generated image';

  const body = (() => {
    if (safeDirectUrl) {
      return <GeneratedImage uri={safeDirectUrl} label={label} onPress={() => openExternal(safeDirectUrl)} />;
    }
    if (sandboxPath && image.phase === 'load' && image.source) {
      return (
        <GeneratedImage
          uri={image.source.uri}
          headers={image.source.headers}
          label={label}
          imageKey={image.attempt}
          onError={image.handleError}
          onPress={() => openFile(sandboxPath)}
        />
      );
    }
    if (sandboxPath && image.phase === 'probing') {
      return (
        <View style={{ paddingHorizontal: webSpace(2), paddingVertical: webSpace(1.5) }}>
          <TextShimmer duration={1} spread={2} style={TURN_TYPE.xs}>
            Loading image preview...
          </TextShimmer>
        </View>
      );
    }
    if (sandboxPath && image.phase === 'tap-to-load') {
      return (
        <View style={{ alignItems: 'flex-start', paddingHorizontal: webSpace(2), paddingVertical: webSpace(1.5) }}>
          <Button variant="secondary" size="sm" onPress={image.loadAnyway}>
            <Text>{image.sizeBytes !== null ? `Tap to load (${formatMegabytes(image.sizeBytes)})` : 'Tap to load'}</Text>
          </Button>
        </View>
      );
    }
    return (
      <Text
        variant="muted"
        selectable
        style={[
          TURN_TYPE.xs,
          {
            paddingHorizontal: webSpace(2),
            paddingVertical: webSpace(1.5),
            fontFamily: monoFont,
            color: palette.mutedForeground,
          },
        ]}
      >
        {imagePath || directUrl}
      </Text>
    );
  })();

  return (
    <BasicTool
      disclosureId={disclosureKey('tool', part.id)}
      icon={ImageIcon}
      trigger={{ title: imageGenTitle(action), subtitle: prompt?.slice(0, 60) }}
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      {imagePath || directUrl ? (
        <ToolResultCard bodyStyle={{ padding: TURN_SPACE.resultFramePad }}>{body}</ToolResultCard>
      ) : output ? (
        <ToolOutputFallback output={output} toolName="image_gen" />
      ) : null}
    </BasicTool>
  );
}
ToolRegistry.register('image-gen', ImageGenTool);
