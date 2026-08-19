'use client';

import { useTheme } from 'next-themes';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState, type ReactNode } from 'react';

import { WallpaperBackground } from '@/components/ui/wallpaper-background';
import { DEFAULT_WALLPAPER_ID, getWallpaperById, type Wallpaper } from '@/lib/wallpapers';

/**
 * /debug/wallpaper — the full-bleed render harness the wallpaper exporter
 * screenshots.
 *
 * The in-product wallpapers are live WebGL compositions, not image files, so
 * the only honest way to hand a user a 5K PNG of one is to render it at the
 * target pixel size and capture the frame. `scripts/generate-wallpapers.mjs`
 * drives this route with Playwright: one wallpaper, one theme, one viewport,
 * no chrome, nothing else on the page.
 *
 * Query params:
 *   id     — wallpaper id from `@/lib/wallpapers` (default: the app default)
 *   theme  — `light` | `dark` (default: dark)
 *   px     — Paper Shader pixel cap; the exporter passes width*height so the
 *            canvas renders at true size instead of the 2 MP app cap
 *
 * `data-wallpaper-ready` lands on <html> once the theme is applied, which is
 * the exporter's cue to start waiting on the canvas.
 */
function WallpaperCapture(): ReactNode {
  const params = useSearchParams();
  const { setTheme, resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  const id = (params.get('id') ?? DEFAULT_WALLPAPER_ID) as Wallpaper['id'];
  const theme = params.get('theme') === 'light' ? 'light' : 'dark';
  const px = Number(params.get('px'));
  const maxPixelCount = Number.isFinite(px) && px > 0 ? px : undefined;

  useEffect(() => {
    setTheme(theme);
    setMounted(true);
  }, [setTheme, theme]);

  useEffect(() => {
    if (mounted && resolvedTheme === theme) {
      document.documentElement.setAttribute('data-wallpaper-ready', '1');
    }
    return () => document.documentElement.removeAttribute('data-wallpaper-ready');
  }, [mounted, resolvedTheme, theme]);

  // Guard against a typo'd id silently exporting the default wallpaper.
  const wallpaper = getWallpaperById(id);
  if (wallpaper.id !== id) {
    return <div className="bg-background text-foreground p-4 font-mono text-sm">unknown id</div>;
  }

  return (
    <div className="bg-background fixed inset-0 isolate overflow-hidden">
      {mounted ? <WallpaperBackground wallpaperId={id} maxPixelCount={maxPixelCount} /> : null}
    </div>
  );
}

export default function WallpaperCapturePage(): ReactNode {
  return (
    <Suspense fallback={null}>
      <WallpaperCapture />
    </Suspense>
  );
}
