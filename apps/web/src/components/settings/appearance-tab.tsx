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

// Reference "real page" size that WallpaperBackground is tuned for.
// The preview renders the component at this size inside a card and scales
// it down via CSS transform so the thumbnail is an exact, identical
// representation of what users see on real pages.
const PREVIEW_REF_WIDTH = 1280;
const PREVIEW_REF_HEIGHT = 720;

function WallpaperCard({
  wallpaper,
  isActive,
  onSelect,
}: {
  wallpaper: Wallpaper;
  isActive: boolean;
  onSelect: () => void;
}) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const [scale, setScale] = React.useState(0.15);

  React.useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => {
      const w = el.getBoundingClientRect().width;
      if (w > 0) setScale(w / PREVIEW_REF_WIDTH);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <button
      type="button"
      onClick={onSelect}
      className="group relative cursor-pointer rounded-lg text-left"
    >
      <div
        ref={containerRef}
        className={cn(
          'relative w-full aspect-video bg-background overflow-hidden rounded-md isolate border transition-colors duration-200',
          isActive ? 'border-primary' : 'border-border group-hover:border-border/80'
        )}
      >
        {/* Render the real WallpaperBackground at its native reference size
            (1280×720) and scale it down to fit the thumbnail. This guarantees
            the preview is pixel-identical to what the user sees on real pages. */}
        <div
          className="absolute top-0 left-0"
          style={{
            width: PREVIEW_REF_WIDTH,
            height: PREVIEW_REF_HEIGHT,
            transformOrigin: 'top left',
            transform: `scale(${scale})`,
          }}
          aria-hidden="true"
        >
          <WallpaperBackground wallpaperId={wallpaper.id} />
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

export function AppearanceTab() {
  const { theme: baseMode, setTheme: setBaseMode } = useTheme();
  const wallpaperId = useUserPreferencesStore(
    (s) => s.preferences.wallpaperId ?? DEFAULT_WALLPAPER_ID
  );
  const setWallpaperId = useUserPreferencesStore((s) => s.setWallpaperId);
  const [mounted, setMounted] = React.useState(false);

  React.useEffect(() => {
    setMounted(true);
  }, []);

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
            {WALLPAPERS.map((wp) => (
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
