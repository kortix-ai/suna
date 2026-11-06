/**
 * An agent's face: its pixel mark on a small tile. Port of apps/web
 * `internal/components/agent-mark.tsx` (`AgentMarkGlyph` in a tile). Ink and
 * tile are theme tokens; the shape, from the agent's slug, is the identity.
 */

import { View } from 'react-native';
import Svg, { Path } from 'react-native-svg';

import { pixelMarkShape } from '@kortix/shared/pixel-mark';
import { useTurnPalette } from './styles';

/** My Kortix's run handle (`mykortix-1a2b3c4d`) wears My Kortix's mark. */
export function agentSlugOfHandle(handle: string): string {
  return /^(mykortix|meta)-[0-9a-f]{8}$/.test(handle) ? 'mykortix' : handle;
}

export function AgentPixelMark({ slug, size = 14, tile = 20 }: { slug: string; size?: 14 | 21; tile?: number }) {
  const palette = useTurnPalette();
  const mark = pixelMarkShape(slug);
  const cell = mark.width === 7 ? size / 7 : Math.max(1, Math.floor(size / 12));
  const width = mark.width * cell;
  const height = mark.height * cell;
  return (
    <View
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      style={{
        width: tile,
        height: tile,
        borderRadius: 4,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: palette.muted,
      }}
    >
      <Svg width={width} height={height} viewBox={`0 0 ${mark.width} ${mark.height}`}>
        <Path d={mark.path} fill={palette.foreground} />
        {mark.ditherPath ? <Path d={mark.ditherPath} fill={palette.foreground} opacity={0.5} /> : null}
      </Svg>
    </View>
  );
}
