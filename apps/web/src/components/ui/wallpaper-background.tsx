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
    // The brandmark renders as ambient light rather than a hard wireframe:
    // a heavily-blurred bloom layer underneath a gently softened outline,
    // both dissolved by a radial mask so the mark's sharp arm tips fade out
    // long before the viewport crops them.
    const brandMarkMask =
      '[mask-image:radial-gradient(ellipse_58%_52%_at_50%_50%,black_32%,transparent_78%)]';
    const brandMarkLayout = cn(
      'absolute left-1/2 h-auto w-[120%] -translate-x-1/2 -translate-y-1/2 object-contain select-none sm:w-[135%] lg:w-[138%]',
      centerTopClass,
      brandMarkMask,
    );
    return (
      <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
        {showBrandMark && (
          <>
            {/* Bloom — the mark as a soft glow behind the line work. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={wallpaper.svgUrl}
              alt=""
              className={cn(brandMarkLayout, 'opacity-60 blur-lg invert dark:invert-0')}
              draggable={false}
            />
            {/* Line work — softened so the 1px stroke reads as light, not bone. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={wallpaper.svgUrl}
              alt=""
              className={cn(
                brandMarkLayout,
                'opacity-90 blur-[1px] invert dark:opacity-100 dark:invert-0',
              )}
              draggable={false}
            />
          </>
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
