'use client';

import { memo } from 'react';
import Image from 'next/image';
import { useUserPreferencesStore } from '@/stores/user-preferences-store';
import { getWallpaperById, DEFAULT_WALLPAPER_ID } from '@/lib/wallpapers';
import { AnimatedBg } from '@/components/ui/animated-bg';
import { ShaderWallpaper } from '@/components/ui/shader-wallpaper';
import { AsciiTunnelShader } from '@/components/ui/ascii-tunnel-shader';
import { MatrixShader } from '@/components/ui/matrix-shader';

interface WallpaperBackgroundProps {
  /** Override the active wallpaper (e.g. for preview thumbnails). When omitted, reads from the user preferences store. */
  wallpaperId?: string;
}

export const WallpaperBackground = memo(function WallpaperBackground({
  wallpaperId: wallpaperIdProp,
}: WallpaperBackgroundProps = {}) {
  const storeWallpaperId = useUserPreferencesStore(
    (s) => s.preferences.wallpaperId ?? DEFAULT_WALLPAPER_ID
  );
  const wallpaperId = wallpaperIdProp ?? storeWallpaperId;
  const wallpaper = getWallpaperById(wallpaperId);

  // ── Variant 1: Brandmark ──────────────────────────────────────────────
  // Full-bleed oversized Kortix symbol outline, faded
  if (wallpaper.type === 'svg') {
    return (
      <div
        className="absolute inset-0 pointer-events-none overflow-hidden"
        aria-hidden="true"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={wallpaper.svgUrl}
          alt=""
          // Sized relative to the wallpaper container (not the viewport), so this
          // looks identical whether rendered full-bleed on a real page or scaled
          // inside an appearance-tab preview thumbnail.
          className="absolute left-1/2 top-[42%] -translate-x-1/2 -translate-y-1/2 w-[140%] sm:w-[160%] lg:w-[162%] h-auto object-contain select-none invert dark:invert-0"
          draggable={false}
        />
      </div>
    );
  }

  // ── Variant 2: Symbol ─────────────────────────────────────────────────
  // Tiny Kortix symbol, dead center, ghost-level opacity
  if (wallpaper.type === 'symbol') {
    return (
      <div
        className="absolute inset-0 pointer-events-none overflow-hidden flex items-center justify-center"
        aria-hidden="true"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={wallpaper.symbolUrl}
          alt=""
          className="w-[clamp(36px,9%,130px)] h-auto object-contain select-none opacity-100 dark:invert -translate-y-[18%]"
          draggable={false}
        />
      </div>
    );
  }

  // ── Variant 3: Aurora ─────────────────────────────────────────────────
  // Layered composition: background symbol watermark + animated arcs
  // breathing on the edges + logomark center + grain overlay.
  //
  // The arcs use fixed pixel positions tuned for a 1280×720 frame, so we
  // render them at that reference size inside a container-query box and
  // scale the whole layer to fit the actual wallpaper container. This
  // makes the layout look identical at full-page and at thumbnail sizes
  // without any JS measurement.
  if (wallpaper.type === 'aurora') {
    return (
      <div
        className="absolute inset-0 pointer-events-none overflow-hidden"
        aria-hidden="true"
        style={{ containerType: 'size' }}
      >
        <div
          className="absolute top-0 left-0 origin-top-left"
          style={{
            width: 1280,
            height: 720,
            transform:
              'scaleX(calc(100cqw / 1280px)) scaleY(calc(100cqh / 720px))',
          }}
        >
          {/* L1 — Animated arcs breathing on the edges */}
          <AnimatedBg
          variant="hero"
          blurMultiplier={1.4}
          sizeMultiplier={1}
          duration={12}
          customArcs={{
            left: [
              {
                pos: { left: -160, top: -40 },
                size: 500,
                tone: 'medium',
                opacity: 0.14,
                delay: 0,
                x: [0, 7, -4, 0],
                y: [0, 5, -3, 0],
                scale: [0.88, 1.04, 0.94, 0.88],
                blur: ['8px', '14px', '10px', '8px'],
              },
              {
                pos: { left: -80, top: 280 },
                size: 580,
                tone: 'dark',
                opacity: 0.18,
                delay: 1.8,
                x: [0, 8, -5, 0],
                y: [0, 6, -3, 0],
                scale: [0.9, 1.05, 0.95, 0.9],
                blur: ['4px', '10px', '6px', '4px'],
              },
            ],
            right: [
              {
                pos: { right: -140, top: -20 },
                size: 540,
                tone: 'dark',
                opacity: 0.16,
                delay: 0.9,
                x: [0, -7, 4, 0],
                y: [0, 6, -3, 0],
                scale: [0.89, 1.05, 0.95, 0.89],
                blur: ['6px', '12px', '8px', '6px'],
              },
              {
                pos: { right: -60, top: 320 },
                size: 440,
                tone: 'light',
                opacity: 0.1,
                delay: 2.5,
                x: [0, -6, 3, 0],
                y: [0, 5, -3, 0],
                scale: [0.92, 1.03, 0.96, 0.92],
                blur: ['12px', '20px', '16px', '12px'],
              },
            ],
          }}
          />
        </div>

        {/* L2 — Kortix logomark, sized relative to the actual container so
             it stays the right size in both real-page and thumbnail
             contexts (independent of the 1280×720 arc scaler above). */}
        <div className="absolute inset-0 flex items-center justify-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={wallpaper.svgUrl}
            alt=""
            className="w-[clamp(48px,13%,170px)] h-auto object-contain select-none invert dark:invert-0 -translate-y-[18%]"
            draggable={false}
          />
        </div>

      </div>
    );
  }

  // ── Variants 4+: WebGL shader compositions ───────────────────────────
  // Each shader wallpaper has its own preset picked by id. Common wrapper
  // and logomark overlay keep the UX identical across shader variants.
  if (wallpaper.type === 'shader') {
    return (
      <div
        className="absolute inset-0 pointer-events-none overflow-hidden"
        aria-hidden="true"
      >
        {wallpaper.id === 'ascii-tunnel' ? (
          <AsciiTunnelShader />
        ) : wallpaper.id === 'matrix' ? (
          <MatrixShader />
        ) : (
          <ShaderWallpaper />
        )}
        <div className="absolute inset-0 flex items-center justify-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={wallpaper.svgUrl}
            alt=""
            className="w-[clamp(48px,13%,170px)] h-auto object-contain select-none opacity-90 drop-shadow-[0_2px_20px_rgba(0,0,0,0.35)] invert dark:invert-0 -translate-y-[18%]"
            draggable={false}
          />
        </div>
      </div>
    );
  }

  // ── Fallback: Image wallpaper ─────────────────────────────────────────
  return (
    <div
      className="absolute inset-0 pointer-events-none overflow-hidden"
      aria-hidden="true"
    >
      <div className="absolute inset-0 dark:block hidden">
        <Image
          src={wallpaper.darkUrl!}
          alt=""
          fill
          className="object-cover select-none"
          unoptimized
          priority
          draggable={false}
        />
      </div>
      <div className="absolute inset-0 dark:hidden">
        <Image
          src={wallpaper.lightUrl!}
          alt=""
          fill
          className="object-cover select-none"
          unoptimized
          priority
          draggable={false}
        />
      </div>
      <div className="absolute inset-0 bg-black/5 dark:bg-black/20" />
    </div>
  );
});
