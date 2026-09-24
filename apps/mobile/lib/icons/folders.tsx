import * as React from 'react';
import Svg, { Path } from 'react-native-svg';

import type { AppIcon, AppIconProps } from './bind';

/**
 * The project Files glyph — two stacked folders, the drawer's Files nav row.
 * Phosphor's `Folders` is a different shape, so mobile draws this one.
 *
 * 24x24 viewBox, stroked with the icon colour, sized like any registry icon.
 */
const FRONT_FOLDER_PATH =
  'M8 17h12a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3.93a2 2 0 0 1-1.66-.9l-.82-1.2a2 2 0 0 0-1.66-.9H8a2 2 0 0 0-2 2v9c0 1.1.9 2 2 2Z';
const BACK_FOLDER_PATH = 'M2 8v11c0 1.1.9 2 2 2h14';

function FoldersGlyph({ size = 24, color = 'currentColor', style, ...rest }: AppIconProps) {
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
      <Path d={FRONT_FOLDER_PATH} />
      <Path d={BACK_FOLDER_PATH} />
    </Svg>
  );
}

export const KortixFoldersIcon: AppIcon = React.memo(FoldersGlyph);
KortixFoldersIcon.displayName = 'FoldersIcon';
