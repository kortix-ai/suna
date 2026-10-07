import * as React from 'react';
import Svg, { Circle, Defs, LinearGradient, Path, Stop } from 'react-native-svg';

/**
 * The official Telegram mark (telegram.org brand logo, viewBox 0 0 240 240):
 * the blue gradient disc with the white paper plane cut out. A brand mark:
 * it never follows the app theme. The gradient id carries a `telegram-`
 * prefix so it cannot collide with another mark's.
 */
export function TelegramIcon({ size = 16 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 240 240">
      <Defs>
        <LinearGradient id="telegram-a" x1="120" y1="0" x2="120" y2="240" gradientUnits="userSpaceOnUse">
          <Stop offset="0" stopColor="#2AABEE" /* hex-allowlist: Telegram brand gradient top #2AABEE */ />
          <Stop offset="1" stopColor="#229ED9" /* hex-allowlist: Telegram brand gradient bottom #229ED9 */ />
        </LinearGradient>
      </Defs>
      <Circle cx="120" cy="120" r="120" fill="url(#telegram-a)" />
      <Path
        fill="#FFFFFF" // hex-allowlist: white plane of the Telegram brand mark
        fillRule="evenodd"
        clipRule="evenodd"
        d="M54.3 118.8c35-15.2 58.3-25.3 70-30.2 33.3-13.9 40.3-16.3 44.8-16.4 1 0 3.2.2 4.7 1.4 1.2 1 1.5 2.3 1.7 3.3s.4 3.1.2 4.7c-1.8 19-9.6 65.1-13.6 86.3-1.7 9-5 12-8.2 12.3-7 .6-12.3-4.6-19-9-10.6-6.9-16.5-11.2-26.8-18-11.9-7.8-4.2-12.1 2.6-19.1 1.8-1.8 32.5-29.8 33.1-32.3.1-.3.1-1.5-.6-2.1-.7-.6-1.7-.4-2.5-.2-1.1.2-17.9 11.4-50.6 33.5-4.8 3.3-9.1 4.9-13 4.8-4.3-.1-12.5-2.4-18.7-4.4-7.5-2.4-13.5-3.7-13-7.9.3-2.2 3.3-4.4 8.9-6.7z"
      />
    </Svg>
  );
}
