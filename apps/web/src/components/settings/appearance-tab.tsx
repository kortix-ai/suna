'use client';

import * as React from 'react';
import { Check, Monitor, Sun, Moon, Palette, ImageIcon } from 'lucide-react';
import { useTheme } from 'next-themes';
import { FilterBar, FilterBarItem } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import { transitionFromElement } from '@/lib/view-transition';
import { useUserPreferencesStore } from '@/stores/user-preferences-store';
import { WALLPAPERS, DEFAULT_WALLPAPER_ID, type Wallpaper } from '@/lib/wallpapers';
import { WallpaperBackground } from '@/components/ui/wallpaper-background';

function WallpaperCard({
  wallpaper,
  isActive,
  onSelect,
}: {
  wallpaper: Wallpaper;
  isActive: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="group relative cursor-pointer rounded-lg text-left"
    >
      <div
        className={cn(
          'relative w-full aspect-video bg-background overflow-hidden rounded-md isolate border transition-colors duration-200',
          isActive ? 'border-primary' : 'border-border group-hover:border-border/80'
        )}
      >
        {/* Render the wallpaper directly at thumbnail size. Every
            WallpaperBackground variant uses `absolute inset-0` as its
            root, so it fills the card edge-to-edge; shader canvases also
            render at native thumbnail resolution for crisp previews. */}
        <div className="absolute inset-0" aria-hidden="true">
          <WallpaperBackground wallpaperId={wallpaper.id} preview />
        </div>
        {/* Hover overlay */}
        <div
          className={cn(
            'absolute inset-0 transition-opacity duration-200 pointer-events-none',
            isActive ? 'bg-black/10' : 'bg-black/0 group-hover:bg-black/10'
          )}
        />
        {/* Check badge */}
        {isActive && (
          <div className="absolute top-1 right-1 size-4 rounded-full bg-primary flex items-center justify-center shadow-md">
            <Check className="size-2.5 text-primary-foreground" />
          </div>
        )}
      </div>
      <div className="px-1.5 py-1">
        <span className="text-[11px] font-medium text-foreground flex items-center gap-1">
          {wallpaper.name}
          {wallpaper.id === DEFAULT_WALLPAPER_ID && (
            <span className="text-[0.5625rem] font-medium px-1 py-px rounded-full bg-muted text-muted-foreground">
              Default
            </span>
          )}
         </span>
       </div>
     </button>
  );
}

const BASE_MODES = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
] as const;

// Wallpapers that don't have a light-mode treatment — hidden from the
// picker (and auto-swapped away if currently active) when the resolved
// theme is light.
const DARK_ONLY_WALLPAPER_IDS = new Set(['matrix', 'ascii-tunnel']);

export function AppearanceTab() {
  const { theme: baseMode, setTheme: setBaseMode, resolvedTheme } = useTheme();
  const wallpaperId = useUserPreferencesStore(
    (s) => s.preferences.wallpaperId ?? DEFAULT_WALLPAPER_ID
  );
  const setWallpaperId = useUserPreferencesStore((s) => s.setWallpaperId);
  const [mounted, setMounted] = React.useState(false);

  React.useEffect(() => {
    setMounted(true);
  }, []);

  const isLight = mounted && resolvedTheme === 'light';

  const visibleWallpapers = React.useMemo(
    () => (isLight ? WALLPAPERS.filter((w) => !DARK_ONLY_WALLPAPER_IDS.has(w.id)) : WALLPAPERS),
    [isLight],
  );

  // If a dark-only wallpaper is active and the user switches to light,
  // fall back to the default so the page doesn't keep rendering it.
  React.useEffect(() => {
    if (isLight && DARK_ONLY_WALLPAPER_IDS.has(wallpaperId)) {
      setWallpaperId(DEFAULT_WALLPAPER_ID);
    }
  }, [isLight, wallpaperId, setWallpaperId]);

  return (
    <div className="p-4 sm:p-6 pb-12 sm:pb-6 space-y-5 sm:space-y-6 min-w-0 max-w-full overflow-x-hidden">
      <div>
        <div className="flex items-center gap-2 mb-1">
          <Palette className="size-5 text-muted-foreground" />
          <h3 className="text-lg font-semibold">Appearance</h3>
        </div>
        <p className="text-sm text-muted-foreground">
          Choose a color mode and wallpaper.
        </p>
      </div>

      <div className="space-y-5 sm:space-y-6">
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-2 block">
            Color Mode
          </label>
          <FilterBar>
            {BASE_MODES.map((mode) => {
              const Icon = mode.icon;
              const isActive = mounted && baseMode === mode.value;
              return (
                <FilterBarItem
                  key={mode.value}
                  value={mode.value}
                  onClick={(e: React.MouseEvent<HTMLButtonElement>) => {
                    if (mode.value === baseMode) return;
                    transitionFromElement(e.currentTarget as HTMLElement, () => setBaseMode(mode.value));
                  }}
                  data-state={isActive ? 'active' : 'inactive'}
                >
                  <Icon className="size-3.5" />
                  {mode.label}
                </FilterBarItem>
              );
            })}
          </FilterBar>
        </div>

        <div>
          <div className="flex items-center gap-2 mb-2">
            <ImageIcon className="size-4 text-muted-foreground" />
            <label className="text-xs font-medium text-muted-foreground">
              Wallpaper
            </label>
          </div>
          <div className="grid grid-cols-3 gap-2">
            {visibleWallpapers.map((wp) => (
              <WallpaperCard
                key={wp.id}
                wallpaper={wp}
                isActive={wallpaperId === wp.id}
                onSelect={() => setWallpaperId(wp.id)}
              />
            ))}
          </div>
        </div>

      </div>
    </div>
  );
}
