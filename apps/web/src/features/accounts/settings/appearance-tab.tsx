'use client';

import { Badge } from '@/components/ui/badge';
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from '@/components/ui/item';
import { Switch } from '@/components/ui/switch';
import { WallpaperBackground } from '@/components/ui/wallpaper-background';
import { Icon } from '@/features/icon/icon';
import { cn } from '@/lib/utils';
import { DEFAULT_WALLPAPER_ID, WALLPAPERS, type Wallpaper } from '@/lib/wallpapers';
import { useUserPreferencesStore } from '@/stores/user-preferences-store';
import { CheckCircleSolid } from '@mynaui/icons-react';
import { useTranslations } from 'next-intl';
import { useTheme } from 'next-themes';
import * as React from 'react';

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
      className="group relative cursor-pointer rounded-md text-left"
    >
      <div
        className={cn(
          'bg-background relative isolate aspect-video w-full overflow-hidden rounded-md border transition-colors duration-200',
          isActive ? 'border-primary/40' : 'border-border group-hover:border-border/80',
        )}
      >
        <div className="absolute inset-0" aria-hidden="true">
          <WallpaperBackground wallpaperId={wallpaper.id} preview />
        </div>

        <div
          className={cn(
            'pointer-events-none absolute inset-0 transition-colors duration-200',
            isActive ? 'bg-transparent' : 'group-hover:bg-foreground/[0.06] bg-transparent',
          )}
        />

        {isActive && (
          <div className="absolute top-2.5 right-2.5">
            <CheckCircleSolid className="size-4" />
          </div>
        )}
      </div>
      <div className="px-1.5 py-1">
        <span className="text-foreground flex items-center gap-1 text-xs font-medium">
          {wallpaper.name}
          {wallpaper.id === DEFAULT_WALLPAPER_ID && (
            <Badge size="sm" variant="secondary">
              Default
            </Badge>
          )}
        </span>
      </div>
    </button>
  );
}

const DARK_ONLY_WALLPAPER_IDS = new Set(['matrix', 'ascii-tunnel']);

export function AppearanceTab() {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const { theme, setTheme, resolvedTheme } = useTheme();
  const wallpaperId = useUserPreferencesStore(
    (s) => s.preferences.wallpaperId ?? DEFAULT_WALLPAPER_ID,
  );
  const setWallpaperId = useUserPreferencesStore((s) => s.setWallpaperId);
  const disableTabSelector = useUserPreferencesStore(
    (s) => s.preferences.disableTabSelector ?? false,
  );
  const setDisableTabSelector = useUserPreferencesStore((s) => s.setDisableTabSelector);
  const [mounted, setMounted] = React.useState(false);

  React.useEffect(() => {
    setMounted(true);
  }, []);

  const isLight = mounted && resolvedTheme === 'light';

  const visibleWallpapers = React.useMemo(
    () => (isLight ? WALLPAPERS.filter((w) => !DARK_ONLY_WALLPAPER_IDS.has(w.id)) : WALLPAPERS),
    [isLight],
  );

  React.useEffect(() => {
    if (isLight && DARK_ONLY_WALLPAPER_IDS.has(wallpaperId)) {
      setWallpaperId(DEFAULT_WALLPAPER_ID);
    }
  }, [isLight, wallpaperId, setWallpaperId]);

  return (
    <div className="scrollbar-hide w-full max-w-full min-w-0 space-y-6 overflow-x-hidden px-6 py-5">
      <div className="flex flex-col space-y-2">
        <label className="text-muted-foreground text-sm font-medium">
          {tHardcodedUi.raw('componentsSettingsAppearanceTab.line127JsxTextColorMode')}
        </label>
        <div className="bg-foreground/10 shadow-custom flex w-fit items-center gap-1 rounded-sm p-0.5">
          <button
            aria-label="Light theme"
            className="[&amp;&gt;svg]:size-4 text-foreground inline-flex h-7 cursor-pointer items-center justify-center gap-1.5 rounded-sm px-2 transition-colors duration-150 ease-out"
            style={{ backgroundColor: theme === 'light' ? 'var(--background)' : 'transparent' }}
            type="button"
            onClick={() => setTheme('light')}
          >
            <Icon.Sun />
            <span className="text-sm font-medium">Light</span>
          </button>
          <button
            aria-label="Dark theme"
            className="[&amp;&gt;svg]:size-4 hover:text-foreground text-foreground inline-flex h-7 cursor-pointer items-center justify-center gap-1.5 rounded-sm px-2 transition-colors duration-150 ease-out"
            type="button"
            style={{ backgroundColor: theme === 'dark' ? 'var(--background)' : 'transparent' }}
            onClick={() => setTheme('dark')}
          >
            <Icon.Moon />
            <span className="text-sm font-medium">Dark</span>
          </button>
          <button
            aria-label="System theme"
            className="[&amp;&gt;svg]:size-4 hover:text-foreground text-foreground inline-flex h-7 cursor-pointer items-center justify-center gap-1.5 rounded-sm px-2 transition-colors duration-150 ease-out"
            type="button"
            style={{ backgroundColor: theme === 'system' ? 'var(--background)' : 'transparent' }}
            onClick={() => setTheme('system')}
          >
            <Icon.Monitor />
            <span className="text-sm font-medium">System</span>
          </button>
        </div>
      </div>

      <div className="flex flex-col space-y-2">
        <label className="text-muted-foreground text-sm font-medium">Wallpaper</label>
        <div className="grid w-full grid-cols-3 gap-2">
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

      <div className="flex flex-col space-y-2">
        <label className="text-muted-foreground text-sm font-medium">Layout</label>
        <Item className="items-start p-0">
          <ItemContent>
            <ItemTitle id="session-tabs-title">
              {tHardcodedUi.raw('componentsSettingsAppearanceTab.line180JsxTextSessionTabs')}
            </ItemTitle>
            <ItemDescription>
              {tHardcodedUi.raw(
                'componentsSettingsAppearanceTab.line182JsxTextShowATabBarAtTheTopOf',
              )}
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <Switch
              id="session-tabs-switch"
              checked={!disableTabSelector}
              onCheckedChange={(v) => setDisableTabSelector(!v)}
            />
          </ItemActions>
        </Item>
      </div>
    </div>
  );
}
