import * as React from 'react';
import Svg, { Path, Rect } from 'react-native-svg';

import type { AppIcon, AppIconProps } from './bind';

/**
 * The project Connectors glyph — three tiles and a turned tile, the drawer's
 * Connectors nav row. Phosphor has no matching shape, so mobile draws this one.
 *
 * 24x24 viewBox, stroked with the icon colour like `folders.tsx`, sized like
 * any registry icon.
 */
// Centred on (17.5, 6.5): the column of the bottom-right tile, the row of the top-left one.
const TURNED_TILE_PATH = 'M17.5 2 22 6.5 17.5 11 13 6.5Z';

function ConnectorsGlyph({ size = 24, color = 'currentColor', style, ...rest }: AppIconProps) {
  const { weight: _weight, mirrored: _mirrored, ...svgProps } = rest as AppIconProps & { mirrored?: boolean };
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={style}
      {...(svgProps as object)}>
      <Rect x={3} y={3} width={7} height={7} rx={1.5} />
      <Rect x={3} y={14} width={7} height={7} rx={1.5} />
      <Rect x={14} y={14} width={7} height={7} rx={1.5} />
      <Path d={TURNED_TILE_PATH} />
    </Svg>
  );
}

export const KortixConnectorsIcon: AppIcon = React.memo(ConnectorsGlyph);
KortixConnectorsIcon.displayName = 'ConnectorsIcon';
