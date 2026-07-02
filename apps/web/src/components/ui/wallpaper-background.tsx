'use client';

import { GrainShader, NeuroShader } from '@/components/ui/paper-wallpaper-shaders';
import { ShaderWallpaper } from '@/components/ui/shader-wallpaper';
import { DitherShader, SilkShader } from '@/components/ui/wallpaper-shaders';
import { cn } from '@/lib/utils';
import { DEFAULT_WALLPAPER_ID, getWallpaperById, Wallpaper } from '@/lib/wallpapers';
import { useUserPreferencesStore } from '@/stores/user-preferences-store';
import Image from 'next/image';
import { memo, type ComponentType } from 'react';

// One shader composition per wallpaper id; unknown shader ids fall back
// to the Pixel Beams preset in ShaderWallpaper.
const SHADER_WALLPAPERS: Partial<Record<Wallpaper['id'], ComponentType>> = {
  silk: SilkShader,
  dither: DitherShader,
  grain: GrainShader,
  neuro: NeuroShader,
};

interface WallpaperBackgroundProps {
  wallpaperId?: Wallpaper['id'];
  preview?: boolean;
  showBrandMark?: boolean;
}

export const WallpaperBackground = memo(function WallpaperBackground({
  wallpaperId: wallpaperIdProp,
  preview = false,
  showBrandMark = true,
}: WallpaperBackgroundProps = {}) {
  const storeWallpaperId = useUserPreferencesStore(
    (s) => s.preferences.wallpaperId ?? DEFAULT_WALLPAPER_ID,
  );
  const wallpaperId = wallpaperIdProp ?? storeWallpaperId;
  const wallpaper = getWallpaperById(wallpaperId);

  const centerTopClass = preview ? 'top-[50%]' : 'top-[46%]';

  // 'Blank' — intentionally render nothing; the page background shows
  // through untouched.
  if (wallpaper.type === 'none') {
    return null;
  }

  if (wallpaper.type === 'svg') {
    return (
      <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
        {showBrandMark && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={wallpaper.svgUrl}
            alt=""
            className={cn(
              'absolute left-1/2 h-auto w-[140%] -translate-x-1/2 -translate-y-1/2 object-contain invert select-none sm:w-[160%] lg:w-[162%] dark:invert-0',
              centerTopClass,
            )}
            draggable={false}
          />
        )}
      </div>
    );
  }

  // ── WebGL shader compositions ────────────────────────────────────────
  // Each shader wallpaper has its own preset picked by id. Shader
  // wallpapers render without the logomark overlay — the composition is
  // the wallpaper.
  if (wallpaper.type === 'shader') {
    const ShaderComponent = SHADER_WALLPAPERS[wallpaper.id] ?? ShaderWallpaper;
    return (
      <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
        <ShaderComponent />
      </div>
    );
  }

  // ── Fallback: Image wallpaper ─────────────────────────────────────────
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
      <div className="absolute inset-0 hidden dark:block">
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
