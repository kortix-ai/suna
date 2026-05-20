'use client';

import * as React from 'react';
import { Check } from 'lucide-react';
import { useTheme } from 'next-themes';
import { cn } from '@kortix/design-system';
import { crossfadeTransition } from '@/lib/view-transition';
import { Switch } from '@/components/ui/switch';
import { useUserPreferencesStore } from '@/stores/user-preferences-store';
import { WALLPAPERS, DEFAULT_WALLPAPER_ID, type Wallpaper } from '@/lib/wallpapers';
import { WallpaperBackground } from '@/components/ui/wallpaper-background';

const PALETTES = {
  light: {
    bg: '#f6f5f3',
    sidebar: '#ececea',
    surface: '#ffffff',
    text: '#1a1a1a',
    textMuted: '#9d9c98',
    border: '#dedcd7',
    accent: '#1a1a1a',
  },
  dark: {
    bg: '#161616',
    sidebar: '#1f1f1f',
    surface: '#202020',
    text: '#f3f2ef',
    textMuted: '#7a7975',
    border: '#2a2a2a',
    accent: '#f3f2ef',
  },
} as const;

interface ThemeOption {
  value: 'light' | 'dark' | 'system';
  label: string;
  caption: string;
}

const THEME_OPTIONS: ThemeOption[] = [
  { value: 'light', label: 'Light', caption: 'Bright surfaces, dark ink.' },
  { value: 'dark', label: 'Dark', caption: 'Low-light surfaces, light ink.' },
  { value: 'system', label: 'Match system', caption: 'Follows your OS preference.' },
];

const DARK_ONLY_WALLPAPER_IDS = new Set(['matrix', 'ascii-tunnel']);

export function AppearanceTab() {
  const { theme, setTheme, resolvedTheme } = useTheme();
  const active = theme ?? 'system';
  const handleThemeChange = (value: string) => {
    if (value === theme) return;
    crossfadeTransition(() => setTheme(value));
  };

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
    () =>
      isLight ? WALLPAPERS.filter((w) => !DARK_ONLY_WALLPAPER_IDS.has(w.id)) : WALLPAPERS,
    [isLight],
  );

  React.useEffect(() => {
    if (isLight && DARK_ONLY_WALLPAPER_IDS.has(wallpaperId)) {
      setWallpaperId(DEFAULT_WALLPAPER_ID);
    }
  }, [isLight, wallpaperId, setWallpaperId]);

  return (
    <div className="grid max-w-3xl gap-12 px-8 pt-8 pb-12">
      <Group label="Theme" hint="Sync with the OS, or override per device." meta={active}>
        <div className="grid grid-cols-1 gap-4 pt-1 sm:grid-cols-3">
          {THEME_OPTIONS.map((opt) => (
            <ThemeCard
              key={opt.value}
              option={opt}
              selected={mounted && active === opt.value}
              onSelect={() => handleThemeChange(opt.value)}
            />
          ))}
        </div>
      </Group>

      <Group
        label="Wallpaper"
        hint="A backdrop for sessions and dashboards."
        meta={
          WALLPAPERS.find((w) => w.id === wallpaperId)?.name?.toLowerCase() ?? 'default'
        }
      >
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {visibleWallpapers.map((wp) => (
            <WallpaperCard
              key={wp.id}
              wallpaper={wp}
              isActive={wallpaperId === wp.id}
              onSelect={() => setWallpaperId(wp.id)}
            />
          ))}
        </div>
      </Group>

      <Group label="Interface" hint="Density and chrome around the canvas.">
        <label
          htmlFor="disable-tab-selector"
          className="flex cursor-pointer items-center justify-between gap-4 rounded-lg px-3 py-3 transition-colors hover:bg-muted/30"
        >
          <div className="min-w-0">
            <div className="font-sans text-[0.85rem] font-medium text-foreground">
              Show tab bar
            </div>
            <div className="mt-0.5 text-[0.75rem] text-muted-foreground">
              When off, the tab bar is hidden and content extends to the top.
            </div>
          </div>
          <Switch
            id="disable-tab-selector"
            checked={!disableTabSelector}
            onCheckedChange={(checked) => setDisableTabSelector(!checked)}
          />
        </label>
      </Group>
    </div>
  );
}

function Group({
  label,
  hint,
  meta,
  children,
}: {
  label: string;
  hint?: string;
  meta?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="grid gap-4">
      <header className="flex items-baseline justify-between gap-4 border-b border-border/40 pb-3">
        <div className="grid gap-1.5">
          <span className="font-mono text-[0.62rem] uppercase tracking-[0.22em] text-muted-foreground/80">
            {label}
          </span>
          {hint ? (
            <p className="max-w-md text-[0.82rem] leading-relaxed text-muted-foreground">
              {hint}
            </p>
          ) : null}
        </div>
        {meta ? (
          <span className="shrink-0 font-mono text-[0.6rem] uppercase tracking-[0.18em] tabular-nums text-muted-foreground/60">
            {meta}
          </span>
        ) : null}
      </header>
      {children}
    </section>
  );
}

function ThemeCard({
  option,
  selected,
  onSelect,
}: {
  option: ThemeOption;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        'group/theme grid gap-3 rounded-xl p-2 text-left transition-colors',
        selected ? 'bg-muted/60' : 'hover:bg-muted/30',
      )}
    >
      <ThemePreview kind={option.value} selected={selected} />
      <div className="flex items-start justify-between gap-2 px-1">
        <div className="grid gap-0.5">
          <span className="font-sans text-[0.85rem] font-medium tracking-tight text-foreground">
            {option.label}
          </span>
          <span className="text-[0.7rem] leading-tight text-muted-foreground">
            {option.caption}
          </span>
        </div>
        <span
          className={cn(
            'mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border transition-colors',
            selected
              ? 'border-foreground bg-foreground text-background'
              : 'border-border/70 bg-transparent',
          )}
          aria-hidden
        >
          {selected ? <Check className="size-2.5" strokeWidth={3} /> : null}
        </span>
      </div>
    </button>
  );
}

function ThemePreview({
  kind,
  selected,
}: {
  kind: 'light' | 'dark' | 'system';
  selected: boolean;
}) {
  return (
    <div
      className={cn(
        'relative aspect-[16/11] overflow-hidden rounded-lg transition-shadow',
        selected ? 'ring-1 ring-foreground/20' : '',
      )}
    >
      {kind === 'system' ? (
        <>
          <PreviewBody palette={PALETTES.dark} />
          <div
            className="absolute inset-0"
            style={{ clipPath: 'inset(0 50% 0 0)' }}
          >
            <PreviewBody palette={PALETTES.light} />
          </div>
          <span
            aria-hidden
            className="absolute inset-y-0 left-1/2 w-px bg-white/15 mix-blend-overlay"
          />
        </>
      ) : (
        <PreviewBody palette={PALETTES[kind]} />
      )}
    </div>
  );
}

function PreviewBody({
  palette,
}: {
  palette: (typeof PALETTES)[keyof typeof PALETTES];
}) {
  return (
    <div
      className="grid h-full w-full"
      style={{
        background: palette.bg,
        color: palette.text,
        gridTemplateColumns: '34% 1fr',
      }}
    >
      <div
        className="flex flex-col gap-1.5 p-2"
        style={{ background: palette.sidebar }}
      >
        <div className="flex items-center gap-1">
          <span
            className="size-2 rounded-sm"
            style={{ background: palette.accent, opacity: 0.85 }}
          />
          <span
            className="h-1 w-6 rounded-sm"
            style={{ background: palette.textMuted, opacity: 0.7 }}
          />
        </div>
        <span
          className="mt-0.5 h-0.5 w-3 rounded-sm"
          style={{ background: palette.textMuted, opacity: 0.4 }}
        />
        <div className="grid gap-1 pt-1">
          <div
            className="h-1.5 rounded-sm"
            style={{ background: palette.text, opacity: 0.32 }}
          />
          <div
            className="h-1.5 w-4/5 rounded-sm"
            style={{ background: palette.textMuted, opacity: 0.4 }}
          />
          <div
            className="h-1.5 w-3/4 rounded-sm"
            style={{ background: palette.textMuted, opacity: 0.4 }}
          />
          <div
            className="h-1.5 w-2/3 rounded-sm"
            style={{ background: palette.textMuted, opacity: 0.4 }}
          />
        </div>
      </div>
      <div className="flex flex-col gap-1 p-2.5">
        <span
          className="h-0.5 w-3 rounded-sm"
          style={{ background: palette.textMuted, opacity: 0.55 }}
        />
        <span
          className="h-1.5 w-10 rounded-sm"
          style={{ background: palette.text, opacity: 0.85 }}
        />
        <span
          className="mt-0.5 h-0.5 w-12 rounded-sm"
          style={{ background: palette.textMuted, opacity: 0.4 }}
        />
        <div className="mt-1.5 grid gap-0.5">
          <div
            className="h-1 rounded-sm"
            style={{ background: palette.textMuted, opacity: 0.22 }}
          />
          <div
            className="h-1 w-11/12 rounded-sm"
            style={{ background: palette.textMuted, opacity: 0.22 }}
          />
          <div
            className="h-1 w-5/6 rounded-sm"
            style={{ background: palette.textMuted, opacity: 0.22 }}
          />
        </div>
        <div
          className="mt-1 h-2 w-8 rounded-sm"
          style={{ background: palette.accent, opacity: 0.85 }}
        />
      </div>
    </div>
  );
}

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
      className="group/wp grid gap-2 rounded-lg p-1.5 text-left transition-colors hover:bg-muted/30"
    >
      <div
        className={cn(
          'relative isolate aspect-video w-full overflow-hidden rounded-md bg-background transition-shadow',
          isActive ? 'ring-1 ring-foreground/20' : '',
        )}
      >
        <div className="absolute inset-0" aria-hidden="true">
          <WallpaperBackground wallpaperId={wallpaper.id} preview />
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 px-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate font-sans text-[0.78rem] font-medium tracking-tight text-foreground">
            {wallpaper.name}
          </span>
          {wallpaper.id === DEFAULT_WALLPAPER_ID ? (
            <span className="shrink-0 font-mono text-[0.5rem] uppercase tracking-[0.22em] text-muted-foreground/60">
              default
            </span>
          ) : null}
        </div>
        <span
          className={cn(
            'flex size-4 shrink-0 items-center justify-center rounded-full border transition-colors',
            isActive
              ? 'border-foreground bg-foreground text-background'
              : 'border-border/70 bg-transparent',
          )}
          aria-hidden
        >
          {isActive ? <Check className="size-2.5" strokeWidth={3} /> : null}
        </span>
      </div>
    </button>
  );
}
