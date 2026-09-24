/**
 * PlanRingAvatar — the profile photo in a gradient ring coloured by the active
 * account's plan family (Jay, 2026-09-23; the project drawer's avatar). The
 * API's plans are Free, Team and Enterprise (`planTier`). The paid rings are
 * metals, banded like polished metal catching light:
 *
 *   Free        a quiet grey ring
 *   Team        silver
 *   Enterprise  champagne gold (the Kortix yellow hue, low saturation)
 *
 * Each metal has a dark and a light set: the light set is darker, so its
 * bands clear the light drawer surface.
 *
 * No known plan (still loading, or a label outside the three) draws the photo alone at
 * the full size. Ring 2pt, then a 2pt gap of `gapColor` (the surface behind),
 * then the photo: the whole control stays `size` points.
 */
import * as React from 'react';
import { View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useColorScheme } from 'nativewind';

import { ProfilePicture } from '@/components/settings/ProfilePicture';
import { planTier, type PlanTier } from '@/lib/billing/plan-tier';
import { THEME, withAlpha } from '@/lib/utils/theme';

const RING_WIDTH = 2;
const RING_GAP = 2;

type Ring = { colors: readonly [string, string, ...string[]]; locations?: readonly [number, number, ...number[]] };

/**
 * Metal banding along the diagonal: light · shadow · highlight · shadow ·
 * light, so the ring reads as polished metal catching light, not a flat blend.
 */
const METAL_LOCATIONS = [0, 0.3, 0.5, 0.72, 1] as const;

/** `hsl()` from a hue and saturation — the metals are recipes, not tokens. */
const hsl = (h: number, s: number, l: number) => `hsl(${h} ${s}% ${l}%)`;

/** The hue of a THEME accent (`hsl(H S% L%)`). */
const hueOf = (color: string) => Number(/hsl\(\s*([\d.]+)/.exec(color)?.[1] ?? 0);

function ringFor(tier: PlanTier, isDark: boolean): Ring {
  switch (tier) {
    case 'free': {
      const muted = (isDark ? THEME.dark : THEME.light).mutedForeground;
      return { colors: [withAlpha(muted, 0.6), withAlpha(muted, 0.25)] };
    }
    case 'team': {
      // Silver (Jay, 2026-09-23). Dark: L 92 · 58 · 97 · 50 · 80 — approved.
      // Light: the dark set's highlights (92, 97) sat on the 95.7% drawer and
      // vanished, so the ring broke into dashes. The light set is one step
      // darker everywhere — L 78 · 46 · 90 · 38 · 66 — so every band clears
      // the surface and the single 90% highlight still reads as a shine.
      const l = isDark ? [92, 58, 97, 50, 80] : [78, 46, 90, 38, 66];
      return { colors: [hsl(0, 0, l[0]), hsl(0, 0, l[1]), hsl(0, 0, l[2]), hsl(0, 0, l[3]), hsl(0, 0, l[4])], locations: METAL_LOCATIONS };
    }
    case 'enterprise': {
      // Champagne gold (Jay, 2026-09-23: the saturated yellow → orange gold
      // read brassy). One warm hue, the Kortix yellow's (48), at low
      // saturation, so it reads as the silver's warm sibling, not a colour.
      // Dark: s 55 · 45 · 60 · 45 · 50, L 82 · 52 · 92 · 44 · 72.
      // Light: darker and a touch richer so it clears the 95.7% drawer —
      // s 50 · 45 · 55 · 45 · 48, L 66 · 38 · 82 · 32 · 56.
      const h = hueOf(THEME.accent.yellow);
      const [sat, l] = isDark
        ? [[55, 45, 60, 45, 50], [82, 52, 92, 44, 72]]
        : [[50, 45, 55, 45, 48], [66, 38, 82, 32, 56]];
      return {
        colors: [hsl(h, sat[0], l[0]), hsl(h, sat[1], l[1]), hsl(h, sat[2], l[2]), hsl(h, sat[3], l[3]), hsl(h, sat[4], l[4])],
        locations: METAL_LOCATIONS,
      };
    }
  }
}

export interface PlanRingAvatarProps {
  imageUrl?: string | null;
  fallbackText?: string;
  planName?: string;
  /** Outer size in points, a multiple of 4. */
  size: number;
  /** The surface behind the avatar: fills the gap between ring and photo. */
  gapColor: string;
}

export function PlanRingAvatar({ imageUrl, fallbackText, planName, size, gapColor }: PlanRingAvatarProps) {
  const { colorScheme } = useColorScheme();
  const tier = planTier(planName);

  // ProfilePicture takes Tailwind units (4pt each).
  if (!tier) return <ProfilePicture imageUrl={imageUrl} size={size / 4} fallbackText={fallbackText} />;

  const photo = size - 2 * (RING_WIDTH + RING_GAP);
  const ring = ringFor(tier, colorScheme === 'dark');
  return (
    <LinearGradient
      colors={ring.colors}
      locations={ring.locations}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={{ width: size, height: size, borderRadius: size / 2, padding: RING_WIDTH }}>
      <View
        style={{
          flex: 1,
          borderRadius: size / 2,
          padding: RING_GAP,
          backgroundColor: gapColor,
        }}>
        <ProfilePicture imageUrl={imageUrl} size={photo / 4} fallbackText={fallbackText} />
      </View>
    </LinearGradient>
  );
}
