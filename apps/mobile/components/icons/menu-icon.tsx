import * as React from 'react';
import Svg, { Path } from 'react-native-svg';

import type { AppIconProps } from '@/lib/icons';

/**
 * The app hamburger: three left-aligned bars of 24, 11, and 13 units (Jay,
 * 2026-09-17). Bespoke art, so it is not a Phosphor registry icon; it takes
 * the same `size` / `color` / `style` props, so it passes anywhere an
 * `AppIcon` does.
 *
 * The artwork is 24×18. The viewBox is padded to a 24×24 square
 * (`0 -3 24 24`), so the icon keeps a square `size` box and the glyph sits
 * vertically centred, like every other icon in a 20pt slot.
 */
export function MenuIcon({ size = 24, color = 'currentColor', style }: AppIconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 -3 24 24" fill="none" style={style}>
      <Path
        fill={color}
        d="M0 1C0 0.734784 0.105357 0.48043 0.292893 0.292893C0.48043 0.105357 0.734784 0 1 0H23C23.2652 0 23.5196 0.105357 23.7071 0.292893C23.8946 0.48043 24 0.734784 24 1C24 1.26522 23.8946 1.51957 23.7071 1.70711C23.5196 1.89464 23.2652 2 23 2H1C0.734784 2 0.48043 1.89464 0.292893 1.70711C0.105357 1.51957 0 1.26522 0 1ZM1 10H10C10.2652 10 10.5196 9.89464 10.7071 9.70711C10.8946 9.51957 11 9.26522 11 9C11 8.73478 10.8946 8.48043 10.7071 8.29289C10.5196 8.10536 10.2652 8 10 8H1C0.734784 8 0.48043 8.10536 0.292893 8.29289C0.105357 8.48043 0 8.73478 0 9C0 9.26522 0.105357 9.51957 0.292893 9.70711C0.48043 9.89464 0.734784 10 1 10ZM12 16H1C0.734784 16 0.48043 16.1054 0.292893 16.2929C0.105357 16.4804 0 16.7348 0 17C0 17.2652 0.105357 17.5196 0.292893 17.7071C0.48043 17.8946 0.734784 18 1 18H12C12.2652 18 12.5196 17.8946 12.7071 17.7071C12.8946 17.5196 13 17.2652 13 17C13 16.7348 12.8946 16.4804 12.7071 16.2929C12.5196 16.1054 12.2652 16 12 16Z"
      />
    </Svg>
  );
}
