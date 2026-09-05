'use client';

/**
 * The Appearance tab — theme, conversation density, wallpaper.
 *
 * Split out of Preferences on 2026-09-02 (Jay: "appearance will be in a
 * separate type"). These three are the only settings that change what the
 * app LOOKS like; everything that changes what it does — language, shortcuts,
 * sounds, notifications — stays on Preferences and Sessions.
 *
 * Theme values come from `THEME_OPTIONS` in `features/layout/user-menu.tsx`
 * (imported, not re-declared) so this control and the user menu's theme
 * submenu can never drift apart. `WallpaperCard` is reused from
 * `features/accounts/settings/appearance-tab.tsx`, the home of the wallpaper
 * picker's card.
 *
 * `AppearanceTabView` is the pure, props-only half — it renders under
 * `renderToStaticMarkup` with no `next-themes` provider or Zustand store (see
 * `appearance-tab.test.tsx`). `AppearanceTab` is the container; it only
 * mounts while this tab is active.
 */

import { CheckCircleIcon as CheckCircleSolid } from '@phosphor-icons/react';
import { useTheme } from 'next-themes';
import { useEffect } from 'react';

import { Separator } from '@/components/ui/separator';
import { SettingsSubsectionHeader } from '@/components/ui/settings-subsection-header';
import { WallpaperCard } from '@/features/accounts/settings/appearance-tab';
import { THEME_OPTIONS } from '@/features/layout/user-menu';
import { cn } from '@/lib/utils';
import { DEFAULT_WALLPAPER_ID, WALLPAPERS, type Wallpaper } from '@/lib/wallpapers';
import { useUserPreferencesStore, type ConversationDensity } from '@/stores/user-preferences-store';
import { SettingsTabHeader } from '../settings-tab-header';

const DENSITY_OPTIONS: { id: ConversationDensity; label: string; description: string }[] = [
  {
    id: 'normal',
    label: 'Normal',
    description: 'Steps and thinking stream live while Kortix works.',
  },
  {
    id: 'minimal',
    label: 'Minimal',
    description: 'One status line until you expand it.',
  },
];

/**
 * Skeleton mock of the live activity burst at each density, drawn with the
 * same bar-and-dot vocabulary as `Skeleton` surfaces. The two previews ARE the
 * explanation — 'normal' shows the summary line over an open chain (rows +
 * thinking paragraph), 'minimal' shows the one status line and the quiet that
 * is the point of the mode. Decorative only, so `aria-hidden`; the card's
 * label + description carry the accessible name.
 */
function DensityPreview({ density }: { density: ConversationDensity }) {
  if (density === 'minimal') {
    return (
      <div aria-hidden>
        <div className="bg-muted-foreground/35 h-1.5 w-16 rounded-full" />
      </div>
    );
  }
  return (
    <div aria-hidden className="space-y-2">
      {/* Summary line */}
      <div className="bg-muted-foreground/35 h-1.5 w-16 rounded-full" />
      {/* Thinking row + its streaming paragraph */}
      <div className="flex items-center gap-2">
        <div className="bg-muted-foreground/30 size-2.5 shrink-0 rounded-full" />
        <div className="bg-muted-foreground/20 h-1.5 w-14 rounded-full" />
      </div>
      <div className="space-y-1.5 pl-5">
        <div className="bg-muted-foreground/15 h-1.5 w-full rounded-full" />
        <div className="bg-muted-foreground/15 h-1.5 w-3/4 rounded-full" />
      </div>
      {/* A tool row */}
      <div className="flex items-center gap-2">
        <div className="bg-muted-foreground/30 size-2.5 shrink-0 rounded-full" />
        <div className="bg-muted-foreground/20 h-1.5 w-20 rounded-full" />
      </div>
    </div>
  );
}

/**
 * One selectable density card — the same shape as `WallpaperCard` (preview
 * panel + caption below), because this section sits beside the wallpaper grid
 * and the two pickers should read as one vocabulary. Radio semantics rather
 * than `aria-pressed` buttons: the two options are exclusive.
 */
function DensityCard({
  option,
  isActive,
  onSelect,
}: {
  option: (typeof DENSITY_OPTIONS)[number];
  isActive: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={isActive}
      data-density={option.id}
      onClick={onSelect}
      className="group relative cursor-pointer rounded-md text-left"
    >
      <div
        className={cn(
          'bg-popover duration-moderate relative h-24 w-full overflow-hidden rounded-md border p-3 transition-colors',
          isActive ? 'border-primary/40' : 'border-border group-hover:border-border/80',
        )}
      >
        <DensityPreview density={option.id} />
        {isActive && (
          <div className="absolute top-2.5 right-2.5">
            <CheckCircleSolid weight="fill" className="size-4" />
          </div>
        )}
      </div>
      <div className="px-1.5 py-1">
        <span className="text-foreground text-xs font-medium">{option.label}</span>
      </div>
    </button>
  );
}

export interface AppearanceTabViewProps {
  theme?: string;
  onThemeChange?: (value: string) => void;
  wallpaperId?: string;
  isLightTheme?: boolean;
  onWallpaperSelect?: (id: Wallpaper['id']) => void;
  conversationDensity?: ConversationDensity;
  onConversationDensityChange?: (density: ConversationDensity) => void;
}

/** Presentational only — no hooks, no store read. Every prop is optional with
 *  a safe default so the bare `<AppearanceTabView />` renders every section. */
export function AppearanceTabView({
  theme = 'system',
  onThemeChange = () => {},
  wallpaperId = DEFAULT_WALLPAPER_ID,
  isLightTheme = false,
  onWallpaperSelect = () => {},
  conversationDensity = 'normal',
  onConversationDensityChange = () => {},
}: AppearanceTabViewProps) {
  return (
    <div className="mx-auto w-full max-w-2xl space-y-8">
      <SettingsTabHeader tab="appearance" />

      {/* Theme */}
      <section className="flex flex-col items-start justify-between gap-4 md:flex-row md:gap-10">
        <SettingsSubsectionHeader
          title="Theme"
          description="Choose how Kortix looks on this device."
        />
        <div className="bg-foreground/10 flex w-fit items-center gap-1 rounded-md p-0.5">
          {THEME_OPTIONS.map(({ value, label, Icon }) => (
            <button
              key={value}
              type="button"
              aria-label={label}
              aria-pressed={theme === value}
              className="text-foreground duration-normal inline-flex h-7 cursor-pointer items-center justify-center gap-1.5 rounded-sm px-3 transition-[color,background-color,scale] ease-out active:scale-[0.96] [&>svg]:size-4"
              style={{ backgroundColor: theme === value ? 'var(--background)' : 'transparent' }}
              onClick={() => onThemeChange(value)}
            >
              <Icon />
              <span className="text-sm font-medium">{label}</span>
            </button>
          ))}
        </div>
      </section>

      <Separator />

      {/* Conversation density */}
      <section className="flex flex-col items-start justify-between gap-4 space-y-3 md:flex-row md:gap-10">
        <SettingsSubsectionHeader
          title="Conversation density"
          description="How much detail the agent shows in the conversation while it works."
        />
        <div
          role="radiogroup"
          aria-label="Conversation density"
          className="grid w-full max-w-xs grid-cols-2 gap-2"
        >
          {DENSITY_OPTIONS.map((option) => (
            <DensityCard
              key={option.id}
              option={option}
              isActive={conversationDensity === option.id}
              onSelect={() => onConversationDensityChange(option.id)}
            />
          ))}
        </div>
      </section>

      <Separator />

      {/* Wallpaper */}
      <section className="space-y-3">
        <SettingsSubsectionHeader
          title="Wallpaper"
          description="The background behind your workspace."
        />
        <div className="grid w-full grid-cols-3 gap-2">
          {WALLPAPERS.map((wp) => (
            <WallpaperCard
              key={wp.id}
              wallpaper={wp}
              thumbSrc={wp.thumbs ? (isLightTheme ? wp.thumbs.light : wp.thumbs.dark) : undefined}
              isActive={wallpaperId === wp.id}
              onSelect={() => onWallpaperSelect(wp.id)}
            />
          ))}
        </div>
      </section>
    </div>
  );
}

/** Container: owns every hook (next-themes, the preferences store) and
 *  renders `AppearanceTabView`. Only ever mounted while this tab is active. */
export function AppearanceTab() {
  const { theme, setTheme, resolvedTheme } = useTheme();

  const wallpaperId = useUserPreferencesStore(
    (s) => s.preferences.wallpaperId ?? DEFAULT_WALLPAPER_ID,
  );
  const setWallpaperId = useUserPreferencesStore((s) => s.setWallpaperId);
  // `?? 'normal'` — legacy persisted preferences predate this key (same rule
  // as every `panelMode` read site).
  const conversationDensity = useUserPreferencesStore(
    (s) => s.preferences.conversationDensity ?? 'normal',
  );
  const setConversationDensity = useUserPreferencesStore((s) => s.setConversationDensity);

  // Users may have a wallpaper persisted that no longer exists — reset it.
  useEffect(() => {
    if (!WALLPAPERS.some((w) => w.id === wallpaperId)) {
      setWallpaperId(DEFAULT_WALLPAPER_ID);
    }
  }, [wallpaperId, setWallpaperId]);

  return (
    <AppearanceTabView
      theme={theme ?? 'system'}
      onThemeChange={setTheme}
      wallpaperId={wallpaperId}
      isLightTheme={resolvedTheme === 'light'}
      onWallpaperSelect={setWallpaperId}
      conversationDensity={conversationDensity}
      onConversationDensityChange={setConversationDensity}
    />
  );
}
