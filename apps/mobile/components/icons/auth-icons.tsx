import * as React from 'react';
import Svg, { Path } from 'react-native-svg';

/**
 * Apple logo (monochrome) rendered with native react-native-svg.
 * Path ported from the shared web icon set (apps/web `Icons.Apple`), viewBox 41.5×51.
 */
export function AppleIcon({ size = 20, color = '#0A0A0A' }: { size?: number; color?: string }) {
  const width = size * (41.5 / 51);
  return (
    <Svg width={width} height={size} viewBox="0 0 41.5 51">
      <Path
        d="M40.2,17.4c-3.4,2.1-5.5,5.7-5.5,9.7c0,4.5,2.7,8.6,6.8,10.3c-0.8,2.6-2,5-3.5,7.2c-2.2,3.1-4.5,6.3-7.9,6.3s-4.4-2-8.4-2c-3.9,0-5.3,2.1-8.5,2.1s-5.4-2.9-7.9-6.5C2,39.5,0.1,33.7,0,27.6c0-9.9,6.4-15.2,12.8-15.2c3.4,0,6.2,2.2,8.3,2.2c2,0,5.2-2.3,9-2.3C34.1,12.2,37.9,14.1,40.2,17.4z M28.3,8.1C30,6.1,30.9,3.6,31,1c0-0.3,0-0.7-0.1-1c-2.9,0.3-5.6,1.7-7.5,3.9c-1.7,1.9-2.7,4.3-2.8,6.9c0,0.3,0,0.6,0.1,0.9c0.2,0,0.5,0.1,0.7,0.1C24.1,11.6,26.6,10.2,28.3,8.1z"
        fill={color}
      />
    </Svg>
  );
}

/**
 * Google "G" (official four-color mark) rendered with native react-native-svg.
 * The web `NewGoogle` icon relies on gradient-href inheritance + blur filters that
 * react-native-svg does not support, so we use the flat official mark here.
 */
export function GoogleIcon({ size = 20 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 48 48">
      <Path
        fill="#4285F4"
        d="M45.12 24.5c0-1.56-.14-3.06-.4-4.5H24v8.51h11.84c-.51 2.75-2.06 5.08-4.39 6.64v5.52h7.11c4.16-3.83 6.56-9.47 6.56-16.17z"
      />
      <Path
        fill="#34A853"
        d="M24 46c5.94 0 10.92-1.97 14.56-5.33l-7.11-5.52c-1.97 1.32-4.49 2.1-7.45 2.1-5.73 0-10.58-3.87-12.31-9.07H4.34v5.7C7.96 41.07 15.4 46 24 46z"
      />
      <Path
        fill="#FBBC05"
        d="M11.69 28.18C11.25 26.86 11 25.45 11 24s.25-2.86.69-4.18v-5.7H4.34C2.85 17.09 2 20.45 2 24s.85 6.91 2.34 9.88l7.35-5.7z"
      />
      <Path
        fill="#EA4335"
        d="M24 10.75c3.23 0 6.13 1.11 8.41 3.29l6.31-6.31C34.91 4.18 29.93 2 24 2 15.4 2 7.96 6.93 4.34 14.12l7.35 5.7c1.73-5.2 6.58-9.07 12.31-9.07z"
      />
    </Svg>
  );
}
