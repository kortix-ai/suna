/**
 * `image-search`. Port of apps/web `tool/tools/image-search-tool.tsx`:
 * - trigger: `Image` · "Image Search" (`text-xs font-medium`) · the humanised
 *   query (mono, muted, truncating) · "2q, 12 images" pushed right (mono,
 *   `text-muted-foreground/60`);
 * - body: an error → `ToolOutputFallback`; images → a 3-column grid of up to 9
 *   square tiles (`gap-1.5 p-1`, `rounded-sm`, cover) in a `ToolResultCard`;
 *   unparsed output → `ToolOutputFallback` over its first 3000 characters.
 *
 * Differences from web: a tile opens the full image in the browser on tap (web
 * opens a new tab); the hover title overlay has no touch equivalent, so the
 * title is the tile's accessibility label.
 */

import { useMemo, useState } from 'react';
import { Image, Pressable, View } from 'react-native';
import { humanizeSearchQuery } from '@kortix/sdk';
import { Text } from '@/components/ui/text';
import { ImageIcon } from '@/lib/icons';
import { disclosureKey } from '@/lib/session/disclosure-store';
import { imageSearchBadge, imageSearchTiles, parseImageSearchOutput } from '@/lib/session/tools/web-media';
import { webSpace } from '@/lib/session/user-message';
import {
  BasicTool,
  ToolOutputFallback,
  isErrorOutput,
  partInput,
  partOutput,
  partStatus,
  useToolNavigation,
  useToolRowVariant,
} from '../shared/infrastructure';
import { ToolRegistry } from '../shared/registry';
import { ToolResultCard } from '../shared/result-card';
import { FONT_MEDIUM, TURN_SPACE, TURN_TYPE, monoFont, useTurnPalette } from '../shared/styles';
import type { ToolProps } from '../shared/types';

const GRID_GAP = webSpace(1.5);

function ImageTile({ url, title, size }: { url: string; title: string; size: number }) {
  const palette = useTurnPalette();
  const { openExternal } = useToolNavigation();
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    <Pressable
      accessibilityRole="imagebutton"
      accessibilityLabel={title || 'Image result'}
      onPress={() => openExternal(url)}
      style={({ pressed }) => ({
        width: size,
        height: size,
        borderRadius: TURN_SPACE.radiusSm,
        overflow: 'hidden',
        backgroundColor: palette.muted,
        opacity: pressed ? 0.8 : 1,
      })}
    >
      <Image source={{ uri: url }} style={{ width: size, height: size }} resizeMode="cover" onError={() => setFailed(true)} />
    </Pressable>
  );
}

function ImageGrid({ tiles }: { tiles: Array<{ url: string; title: string }> }) {
  const [width, setWidth] = useState(0);
  const size = width > 0 ? Math.floor((width - GRID_GAP * 2) / 3) : 0;
  return (
    <View
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      style={{ flexDirection: 'row', flexWrap: 'wrap', gap: GRID_GAP, padding: TURN_SPACE.resultFramePad }}
    >
      {size > 0 ? tiles.map((tile) => <ImageTile key={tile.url} url={tile.url} title={tile.title} size={size} />) : null}
    </View>
  );
}

export function ImageSearchTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const palette = useTurnPalette();
  const { chain } = useToolRowVariant();
  const input = partInput(part);
  const output = partOutput(part);
  const status = partStatus(part);
  const query = typeof input.query === 'string' ? input.query : '';
  const errored = useMemo(() => isErrorOutput(output), [output]);
  const parsed = useMemo(() => parseImageSearchOutput(output, query), [output, query]);
  const tiles = useMemo(() => imageSearchTiles(parsed.imageResults), [parsed]);
  const badge = imageSearchBadge(parsed);
  const type = chain ? TURN_TYPE.rowSm : TURN_TYPE.xs;

  return (
    <BasicTool
      disclosureId={disclosureKey('tool', part.id)}
      icon={ImageIcon}
      trigger={
        <View style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: TURN_SPACE.gap1_5 }}>
          <Text variant="muted" style={[type, { flexShrink: 0, fontFamily: FONT_MEDIUM, color: palette.foreground }]}>
            Image Search
          </Text>
          <Text
            variant="muted"
            numberOfLines={1}
            style={[type, { flexShrink: 1, fontFamily: monoFont, color: palette.mutedForeground }]}
          >
            {humanizeSearchQuery(parsed.displayQuery)}
          </Text>
          {badge ? (
            <Text
              variant="muted"
              numberOfLines={1}
              style={[type, { marginLeft: 'auto', flexShrink: 0, fontFamily: monoFont, color: palette.muted60 }]}
            >
              {badge}
            </Text>
          ) : null}
        </View>
      }
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      {status === 'completed' && errored ? (
        <ToolOutputFallback output={output} toolName="image_search" />
      ) : parsed.imageResults.length > 0 ? (
        <ToolResultCard>
          <ImageGrid tiles={tiles} />
        </ToolResultCard>
      ) : output ? (
        <ToolOutputFallback output={output.slice(0, 3000)} isStreaming={status === 'running'} toolName="image_search" />
      ) : null}
    </BasicTool>
  );
}
ToolRegistry.register('image-search', ImageSearchTool);
