import * as React from 'react';
import Svg, { Defs, LinearGradient, Path, RadialGradient, Rect, Stop } from 'react-native-svg';

/**
 * The Microsoft Teams mark, converted from the web `MicrosoftTeams` icon
 * (`apps/web/src/features/icon/icons/microsoft-teams.tsx`, viewBox 4 4 36 38)
 * element for element; `teams-icon.test.ts` pins the two together. Gradient
 * ids carry a `teams-` prefix so they cannot collide with another mark's. A
 * brand mark: it never follows the app theme.
 */
export function TeamsIcon({ size = 16 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="4 4 36 38" fill="none">
      <Path
        fill="url(#teams-a)"
        d="M22 20h12c3.31 0 6 2.69 6 6v10c0 3.31-2.69 6-6 6s-6-2.69-6-6V26c0-3.31-2.69-6-6-6"
      />
      <Path
        fill="url(#teams-b)"
        d="M8 24c0-3.31 2.69-6 6-6h8c3.31 0 6 2.69 6 6v12c0 3.31 2.69 6 6 6l-16-.0001c-5.52 0-10-4.48-10-10z"
      />
      <Path
        fill="url(#teams-c)"
        fillOpacity=".7"
        d="M8 24c0-3.31 2.69-6 6-6h8c3.31 0 6 2.69 6 6v12c0 3.31 2.69 6 6 6l-16-.0001c-5.52 0-10-4.48-10-10z"
      />
      <Path
        fill="url(#teams-d)"
        fillOpacity=".7"
        d="M8 24c0-3.31 2.69-6 6-6h8c3.31 0 6 2.69 6 6v12c0 3.31 2.69 6 6 6l-16-.0001c-5.52 0-10-4.48-10-10z"
      />
      <Path
        fill="url(#teams-e)"
        d="M33 18c2.76 0 5-2.24 5-5s-2.24-5-5-5-5 2.24-5 5 2.24 5 5 5"
      />
      <Path
        fill="url(#teams-f)"
        fillOpacity=".46"
        d="M33 18c2.76 0 5-2.24 5-5s-2.24-5-5-5-5 2.24-5 5 2.24 5 5 5"
      />
      <Path
        fill="url(#teams-g)"
        fillOpacity=".4"
        d="M33 18c2.76 0 5-2.24 5-5s-2.24-5-5-5-5 2.24-5 5 2.24 5 5 5"
      />
      <Path
        fill="url(#teams-h)"
        d="M18 16c3.31 0 6-2.69 6-6 0-3.31-2.69-6-6-6s-6 2.69-6 6c0 3.31 2.69 6 6 6"
      />
      <Path
        fill="url(#teams-i)"
        fillOpacity=".6"
        d="M18 16c3.31 0 6-2.69 6-6 0-3.31-2.69-6-6-6s-6 2.69-6 6c0 3.31 2.69 6 6 6"
      />
      <Path
        fill="url(#teams-j)"
        fillOpacity=".5"
        d="M18 16c3.31 0 6-2.69 6-6 0-3.31-2.69-6-6-6s-6 2.69-6 6c0 3.31 2.69 6 6 6"
      />
      <Rect
        width="16"
        height="16"
        x="4"
        y="23"
        fill="url(#teams-k)"
        rx="3.25"
      />
      <Rect
        width="16"
        height="16"
        x="4"
        y="23"
        fill="url(#teams-l)"
        fillOpacity=".7"
        rx="3.25"
      />
      <Path
        fill="#fff" // hex-allowlist: Microsoft Teams logo #fff, fixed brand mark — never themed
        d="M15.48 28.11h-2.45v7.466h-2.06v-7.466H8.52v-1.68h6.96z"
      />
      <Defs
      >
        <RadialGradient
          id="teams-a"
          cx="0"
          cy="0"
          r="1"
          gradientTransform="matrix(13.4784 0 0 33.2694 39.7967 22.1739)"
          gradientUnits="userSpaceOnUse"
        >
          <Stop
            stopColor="#a98aff" // hex-allowlist: Microsoft Teams logo #a98aff, fixed brand mark — never themed
          />
          <Stop
            offset=".14"
            stopColor="#8c75ff" // hex-allowlist: Microsoft Teams logo #8c75ff, fixed brand mark — never themed
          />
          <Stop
            offset=".565"
            stopColor="#5f50e2" // hex-allowlist: Microsoft Teams logo #5f50e2, fixed brand mark — never themed
          />
          <Stop
            offset=".9"
            stopColor="#3c2cb8" // hex-allowlist: Microsoft Teams logo #3c2cb8, fixed brand mark — never themed
          />
        </RadialGradient>
        <RadialGradient
          id="teams-b"
          cx="0"
          cy="0"
          r="1"
          gradientTransform="rotate(68.1539 -7.71566095 14.71355834)scale(32.752 33.1231)"
          gradientUnits="userSpaceOnUse"
        >
          <Stop
            stopColor="#85c2ff" // hex-allowlist: Microsoft Teams logo #85c2ff, fixed brand mark — never themed
          />
          <Stop
            offset=".69"
            stopColor="#7588ff" // hex-allowlist: Microsoft Teams logo #7588ff, fixed brand mark — never themed
          />
          <Stop
            offset="1"
            stopColor="#6459fe" // hex-allowlist: Microsoft Teams logo #6459fe, fixed brand mark — never themed
          />
        </RadialGradient>
        <RadialGradient
          id="teams-d"
          cx="0"
          cy="0"
          r="1"
          gradientTransform="rotate(113.326 8.09285255 17.64474501)scale(19.2186 15.4273)"
          gradientUnits="userSpaceOnUse"
        >
          <Stop
            stopColor="#bd96ff" // hex-allowlist: Microsoft Teams logo #bd96ff, fixed brand mark — never themed
          />
          <Stop
            offset=".686685"
            stopColor="#bd96ff" // hex-allowlist: Microsoft Teams logo #bd96ff, fixed brand mark — never themed
            stopOpacity="0"
          />
        </RadialGradient>
        <RadialGradient
          id="teams-e"
          cx="0"
          cy="0"
          r="1"
          gradientTransform="matrix(0 -10 12.6216 0 32.9999 11.5714)"
          gradientUnits="userSpaceOnUse"
        >
          <Stop
            offset=".268201"
            stopColor="#6868f7" // hex-allowlist: Microsoft Teams logo #6868f7, fixed brand mark — never themed
          />
          <Stop
            offset="1"
            stopColor="#3923b1" // hex-allowlist: Microsoft Teams logo #3923b1, fixed brand mark — never themed
          />
        </RadialGradient>
        <RadialGradient
          id="teams-f"
          cx="0"
          cy="0"
          r="1"
          gradientTransform="rotate(40.0516 -.03068196 44.8729095)scale(7.14629 10.3363)"
          gradientUnits="userSpaceOnUse"
        >
          <Stop
            offset=".270711"
            stopColor="#a1d3ff" // hex-allowlist: Microsoft Teams logo #a1d3ff, fixed brand mark — never themed
          />
          <Stop
            offset=".813393"
            stopColor="#a1d3ff" // hex-allowlist: Microsoft Teams logo #a1d3ff, fixed brand mark — never themed
            stopOpacity="0"
          />
        </RadialGradient>
        <RadialGradient
          id="teams-g"
          cx="0"
          cy="0"
          r="1"
          gradientTransform="rotate(-41.6581 32.11799918 -43.41948423)scale(8.51275 20.8824)"
          gradientUnits="userSpaceOnUse"
        >
          <Stop
            stopColor="#e3acfd" // hex-allowlist: Microsoft Teams logo #e3acfd, fixed brand mark — never themed
          />
          <Stop
            offset=".816041"
            stopColor="#9fa2ff" // hex-allowlist: Microsoft Teams logo #9fa2ff, fixed brand mark — never themed
            stopOpacity="0"
          />
        </RadialGradient>
        <RadialGradient
          id="teams-h"
          cx="0"
          cy="0"
          r="1"
          gradientTransform="matrix(0 -12 15.146 0 17.9999 8.28571)"
          gradientUnits="userSpaceOnUse"
        >
          <Stop
            offset=".268201"
            stopColor="#8282ff" // hex-allowlist: Microsoft Teams logo #8282ff, fixed brand mark — never themed
          />
          <Stop
            offset="1"
            stopColor="#3923b1" // hex-allowlist: Microsoft Teams logo #3923b1, fixed brand mark — never themed
          />
        </RadialGradient>
        <RadialGradient
          id="teams-i"
          cx="0"
          cy="0"
          r="1"
          gradientTransform="rotate(40.0516 -3.15465147 21.41641466)scale(8.57554 12.4035)"
          gradientUnits="userSpaceOnUse"
        >
          <Stop
            offset=".270711"
            stopColor="#a1d3ff" // hex-allowlist: Microsoft Teams logo #a1d3ff, fixed brand mark — never themed
          />
          <Stop
            offset=".813393"
            stopColor="#a1d3ff" // hex-allowlist: Microsoft Teams logo #a1d3ff, fixed brand mark — never themed
            stopOpacity="0"
          />
        </RadialGradient>
        <RadialGradient
          id="teams-j"
          cx="0"
          cy="0"
          r="1"
          gradientTransform="rotate(-41.6581 20.38180375 -26.51566158)scale(10.2153 25.0589)"
          gradientUnits="userSpaceOnUse"
        >
          <Stop
            stopColor="#e3acfd" // hex-allowlist: Microsoft Teams logo #e3acfd, fixed brand mark — never themed
          />
          <Stop
            offset=".816041"
            stopColor="#9fa2ff" // hex-allowlist: Microsoft Teams logo #9fa2ff, fixed brand mark — never themed
            stopOpacity="0"
          />
        </RadialGradient>
        <RadialGradient
          id="teams-k"
          cx="0"
          cy="0"
          r="1"
          gradientTransform="rotate(45 -25.76345597 16.32842712)scale(22.6274)"
          gradientUnits="userSpaceOnUse"
        >
          <Stop
            offset=".046875"
            stopColor="#688eff" // hex-allowlist: Microsoft Teams logo #688eff, fixed brand mark — never themed
          />
          <Stop
            offset=".946875"
            stopColor="#230f94" // hex-allowlist: Microsoft Teams logo #230f94, fixed brand mark — never themed
          />
        </RadialGradient>
        <RadialGradient
          id="teams-l"
          cx="0"
          cy="0"
          r="1"
          gradientTransform="matrix(0 11.2 -13.0702 0 12 32.6)"
          gradientUnits="userSpaceOnUse"
        >
          <Stop
            offset=".570647"
            stopColor="#6965f6" // hex-allowlist: Microsoft Teams logo #6965f6, fixed brand mark — never themed
            stopOpacity="0"
          />
          <Stop
            offset="1"
            stopColor="#8f8fff" // hex-allowlist: Microsoft Teams logo #8f8fff, fixed brand mark — never themed
          />
        </RadialGradient>
        <LinearGradient
          id="teams-c"
          x1="20.5936"
          x2="20.5936"
          y1="18"
          y2="42"
          gradientUnits="userSpaceOnUse"
        >
          <Stop
            offset=".801159"
            stopColor="#6864f6" // hex-allowlist: Microsoft Teams logo #6864f6, fixed brand mark — never themed
            stopOpacity="0"
          />
          <Stop
            offset="1"
            stopColor="#5149de" // hex-allowlist: Microsoft Teams logo #5149de, fixed brand mark — never themed
          />
        </LinearGradient>
      </Defs>
    </Svg>
  );
}
