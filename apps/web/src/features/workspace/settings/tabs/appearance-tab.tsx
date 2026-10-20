'use client';

/**
 * The Appearance tab — theme, conversation density, rich answers, wallpaper.
 *
 * Split out of Preferences on 2026-09-02 (Jay: "appearance will be in a
 * separate type"). These are the only settings that change what the app
 * LOOKS like (rich answers changes how an answer is drawn, not what it
 * says); everything that changes what it does — language, shortcuts,
 * sounds, notifications — stays on Preferences and Sessions.
 *
 * Theme rows come from `INTERFACE_THEME_OPTIONS` in
 * `features/layout/interface-theme.tsx` (imported, not re-declared) so this
 * control, the user menu's theme submenu and the command palette can never
 * drift apart. `WallpaperCard` is reused from
 * `features/accounts/settings/appearance-tab.tsx`, the home of the wallpaper
 * picker's card.
 *
 * `AppearanceTabView` is the pure, props-only half — it renders under
 * `renderToStaticMarkup` with no `next-themes` provider or Zustand store (see
 * `appearance-tab.test.tsx`). `AppearanceTab` is the container; it only
 * mounts while this tab is active.
 */

import { useTranslations } from '@/i18n/use-translations';
import {
  CaretDownIcon,
  CheckCircleIcon as CheckCircleSolid,
  CheckIcon,
} from '@phosphor-icons/react';
import { useTheme } from 'next-themes';
import { useEffect, useState } from 'react';

import {
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandPopover,
  CommandPopoverContent,
  CommandPopoverTrigger,
  CommandSeparator,
} from '@/components/ui/command';
import { Separator } from '@/components/ui/separator';
import { SettingsSubsectionHeader } from '@/components/ui/settings-subsection-header';
import { Switch } from '@/components/ui/switch';
import {
  TRIGGER_CARET_CLASS,
  TRIGGER_ICON_SIZE,
  triggerVariants,
} from '@/components/ui/trigger-variants';
import { WallpaperCard } from '@/features/accounts/settings/appearance-tab';
import { useGenuiEnabled } from '@/features/genui/use-genui-enabled';
import {
  INTERFACE_THEME_OPTIONS,
  ThemeSwatch,
  useInterfaceTheme,
  type InterfaceThemeLabel,
  type InterfaceThemeOption,
} from '@/features/layout/interface-theme';
import {
  DEFAULT_THEME_CHOICE,
  type InterfaceThemeId,
  type ThemeChoice,
} from '@/lib/interface-themes';
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

export interface AppearanceTabCopy {
  theme: string;
  themeDescription: string;
  conversationDensity: string;
  conversationDensityDescription: string;
  richAnswers: string;
  richAnswersDescription: string;
  wallpaper: string;
  wallpaperDescription: string;
  defaultWallpaper: string;
  themes: Record<InterfaceThemeLabel, string>;
  /** Captions for the three groups under the System row. */
  themeGroups: { kortix: string; lightThemes: string; darkThemes: string };
  /** The theme picker's search field and its empty state. */
  themeSearch: { placeholder: string; empty: string };
  densities: Record<ConversationDensity, { label: string; description: string }>;
  wallpapers: Record<Wallpaper['id'], string>;
}

export const DEFAULT_APPEARANCE_TAB_COPY: AppearanceTabCopy = {
  theme: 'Theme',
  themeDescription: 'Choose how Kortix looks on this device.',
  conversationDensity: 'Conversation density',
  conversationDensityDescription:
    'How much detail the agent shows in the conversation while it works.',
  richAnswers: 'Rich answers',
  richAnswersDescription:
    'Show comparisons, tables, charts, and maps as visuals in answers. When off, the same content appears as text.',
  wallpaper: 'Wallpaper',
  wallpaperDescription: 'The background behind your workspace.',
  defaultWallpaper: 'Default',
  themes: {
    system: 'System',
    light: 'Light',
    pureLight: 'Pure light',
    dark: 'Dark',
    pureDark: 'Pure dark',
  },
  themeGroups: {
    kortix: 'Kortix',
    lightThemes: 'Light themes',
    darkThemes: 'Dark themes',
  },
  themeSearch: {
    placeholder: 'Search themes…',
    empty: 'No themes found',
  },
  densities: {
    normal: {
      label: 'Normal',
      description: 'Steps and thinking stream live while Kortix works.',
    },
    minimal: { label: 'Minimal', description: 'One status line until you expand it.' },
  },
  wallpapers: {
    dither: 'Dither',
    brandmark: 'Brandmark',
    nebula: 'Pixel Beams',
    silk: 'Silk',
    grain: 'Grain',
    neuro: 'Neuro',
    blank: 'Blank',
  },
};

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
  theme?: InterfaceThemeId;
  onThemeChange?: (value: InterfaceThemeId) => void;
  /** Palettes the System swatch previews — the themes System resolves to. */
  themeChoice?: ThemeChoice;
  wallpaperId?: string;
  isLightTheme?: boolean;
  onWallpaperSelect?: (id: Wallpaper['id']) => void;
  conversationDensity?: ConversationDensity;
  onConversationDensityChange?: (density: ConversationDensity) => void;
  genuiEnabled?: boolean;
  onGenuiEnabledChange?: (enabled: boolean) => void;
  copy?: AppearanceTabCopy;
}

const optionFor = (value: InterfaceThemeId) =>
  INTERFACE_THEME_OPTIONS.find((option) => option.value === value) ?? INTERFACE_THEME_OPTIONS[0];

/** A row's display name: the translated catalog entry for a Kortix row, the
 *  terminal theme's own proper noun (verbatim, never translated) otherwise. */
const nameFor = (option: InterfaceThemeOption, copy: AppearanceTabCopy): string =>
  option.kind === 'labelled' ? copy.themes[option.labelKey] : option.name;

/** The catalog group a row is listed under. */
const groupFor = (option: InterfaceThemeOption, copy: AppearanceTabCopy): string => {
  if (option.kind === 'labelled') return copy.themeGroups.kortix;
  return option.group === 'dark' ? copy.themeGroups.darkThemes : copy.themeGroups.lightThemes;
};

/** A row's cmdk value: its name, id and group, which search matches and which
 *  `defaultValue` names to open the list on the applied theme. */
export const themeRowValue = (value: InterfaceThemeId, copy: AppearanceTabCopy): string => {
  const option = optionFor(value);
  return `${nameFor(option, copy)} ${option.value} ${groupFor(option, copy)}`;
};

const KORTIX_OPTIONS = INTERFACE_THEME_OPTIONS.filter(
  (option): option is Extract<InterfaceThemeOption, { kind: 'labelled' }> =>
    option.kind === 'labelled' && option.value !== 'system',
);
const LIGHT_TERMINAL_OPTIONS = INTERFACE_THEME_OPTIONS.filter(
  (option) => option.kind === 'named' && option.group === 'light',
);
const DARK_TERMINAL_OPTIONS = INTERFACE_THEME_OPTIONS.filter(
  (option) => option.kind === 'named' && option.group === 'dark',
);

/**
 * The theme picker: a combobox, not a Select. 44 rows are too many to scan,
 * and a Select's type-ahead only jumps to the next row whose label STARTS
 * with the typed letters — "night" never finds "Tokyo Night". Opening focuses
 * a search field; cmdk filters on each row's name, id and group, so "rose",
 * "tokyo night" and "dark" all find what a person expects. The panel aligns
 * to the trigger's end edge because the trigger sits at the right of the
 * settings row.
 */
function ThemePicker({
  theme,
  themeChoice,
  onThemeChange,
  copy,
}: {
  theme: InterfaceThemeId;
  themeChoice: ThemeChoice;
  onThemeChange: (theme: InterfaceThemeId) => void;
  copy: AppearanceTabCopy;
}) {
  const [open, setOpen] = useState(false);

  const row = (option: InterfaceThemeOption) => {
    const label = nameFor(option, copy);
    return (
      <CommandItem
        key={option.value}
        value={themeRowValue(option.value, copy)}
        onSelect={() => {
          onThemeChange(option.value);
          setOpen(false);
        }}
      >
        <ThemeSwatch value={option.value} choice={themeChoice} />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {option.value === theme && <CheckIcon className="text-foreground size-4" />}
      </CommandItem>
    );
  };

  return (
    <CommandPopover open={open} onOpenChange={setOpen}>
      <CommandPopoverTrigger>
        <button
          type="button"
          id="appearance-theme"
          aria-label={copy.theme}
          className={cn(triggerVariants({}), 'hit-area-y-4 hit-area-l-4 w-48')}
        >
          <span className="flex min-w-0 items-center gap-2">
            <ThemeSwatch value={theme} choice={themeChoice} />
            <span className="truncate">{nameFor(optionFor(theme), copy)}</span>
          </span>
          <CaretDownIcon className={cn(TRIGGER_CARET_CLASS, TRIGGER_ICON_SIZE.sm)} />
        </button>
      </CommandPopoverTrigger>
      <CommandPopoverContent
        side="bottom"
        align="end"
        sideOffset={6}
        shouldFilter
        // cmdk marks the highlighted row `aria-selected`: open on the applied
        // theme, not on the first row, so a screen reader announces it.
        defaultValue={themeRowValue(theme, copy)}
        className={cn(
          'w-[min(280px,calc(100vw-1.5rem))]',
          // Group captions read as plain menu labels (MENU_LABEL), not the
          // command popover's tracked-out caps.
          '[&_[cmdk-group-heading]]:!text-muted-foreground [&_[cmdk-group-heading]]:!font-sans [&_[cmdk-group-heading]]:!font-medium [&_[cmdk-group-heading]]:!tracking-normal',
        )}
      >
        <CommandInput compact placeholder={copy.themeSearch.placeholder} />
        <CommandList className="max-h-[360px]">
          <CommandEmpty>{copy.themeSearch.empty}</CommandEmpty>
          <CommandGroup>{row(optionFor('system'))}</CommandGroup>
          <CommandSeparator />
          <CommandGroup heading={copy.themeGroups.kortix}>
            {KORTIX_OPTIONS.map((option) => row(option))}
          </CommandGroup>
          <CommandSeparator />
          <CommandGroup heading={copy.themeGroups.lightThemes}>
            {LIGHT_TERMINAL_OPTIONS.map((option) => row(option))}
          </CommandGroup>
          <CommandSeparator />
          <CommandGroup heading={copy.themeGroups.darkThemes}>
            {DARK_TERMINAL_OPTIONS.map((option) => row(option))}
          </CommandGroup>
        </CommandList>
      </CommandPopoverContent>
    </CommandPopover>
  );
}

/** Presentational only — no hooks, no store read. Every prop is optional with
 *  a safe default so the bare `<AppearanceTabView />` renders every section. */
export function AppearanceTabView({
  theme = 'system',
  onThemeChange = () => {},
  themeChoice = DEFAULT_THEME_CHOICE,
  wallpaperId = DEFAULT_WALLPAPER_ID,
  isLightTheme = false,
  onWallpaperSelect = () => {},
  conversationDensity = 'normal',
  onConversationDensityChange = () => {},
  genuiEnabled = true,
  onGenuiEnabledChange = () => {},
  copy = DEFAULT_APPEARANCE_TAB_COPY,
}: AppearanceTabViewProps) {
  return (
    <div className="mx-auto w-full max-w-2xl space-y-8">
      <SettingsTabHeader tab="appearance" />

      {/* Theme */}
      <section className="flex flex-col items-start justify-between gap-4 md:flex-row md:gap-10">
        <SettingsSubsectionHeader title={copy.theme} description={copy.themeDescription} />
        <ThemePicker
          theme={theme}
          themeChoice={themeChoice}
          onThemeChange={onThemeChange}
          copy={copy}
        />
      </section>

      <Separator />

      {/* Conversation density */}
      <section className="flex flex-col items-start justify-between gap-4 space-y-3 md:flex-row md:gap-10">
        <SettingsSubsectionHeader
          title={copy.conversationDensity}
          description={copy.conversationDensityDescription}
        />
        <div
          role="radiogroup"
          aria-label={copy.conversationDensity}
          className="grid w-full max-w-xs grid-cols-2 gap-2"
        >
          {DENSITY_OPTIONS.map((option) => (
            <DensityCard
              key={option.id}
              option={{ id: option.id, ...copy.densities[option.id] }}
              isActive={conversationDensity === option.id}
              onSelect={() => onConversationDensityChange(option.id)}
            />
          ))}
        </div>
      </section>

      <Separator />

      {/* Rich answers — a switch stays beside its label at every width, so
          this row does not stack on mobile like the pickers above. */}
      <section className="flex items-start justify-between gap-4 md:gap-10">
        <SettingsSubsectionHeader
          title={copy.richAnswers}
          description={copy.richAnswersDescription}
        />
        <Switch
          checked={genuiEnabled}
          onCheckedChange={onGenuiEnabledChange}
          aria-label={copy.richAnswers}
        />
      </section>

      <Separator />

      {/* Wallpaper */}
      <section className="space-y-3">
        <SettingsSubsectionHeader title={copy.wallpaper} description={copy.wallpaperDescription} />
        <div className="grid w-full grid-cols-3 gap-2">
          {WALLPAPERS.map((wp) => (
            <WallpaperCard
              key={wp.id}
              wallpaper={{ ...wp, name: copy.wallpapers[wp.id] }}
              thumbSrc={wp.thumbs ? (isLightTheme ? wp.thumbs.light : wp.thumbs.dark) : undefined}
              isActive={wallpaperId === wp.id}
              onSelect={() => onWallpaperSelect(wp.id)}
              defaultLabel={copy.defaultWallpaper}
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
  const t = useTranslations('settings.appearance');
  const { resolvedTheme } = useTheme();
  const { selected, select, choice } = useInterfaceTheme();

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
  const genuiEnabled = useGenuiEnabled();
  const setGenuiEnabled = useUserPreferencesStore((s) => s.setGenuiEnabled);

  // Users may have a wallpaper persisted that no longer exists — reset it.
  useEffect(() => {
    if (!WALLPAPERS.some((w) => w.id === wallpaperId)) {
      setWallpaperId(DEFAULT_WALLPAPER_ID);
    }
  }, [wallpaperId, setWallpaperId]);

  return (
    <AppearanceTabView
      copy={{
        theme: t('theme'),
        themeDescription: t('themeDescription'),
        conversationDensity: t('conversationDensity'),
        conversationDensityDescription: t('conversationDensityDescription'),
        richAnswers: t('richAnswers'),
        richAnswersDescription: t('richAnswersDescription'),
        wallpaper: t('wallpaper'),
        wallpaperDescription: t('wallpaperDescription'),
        defaultWallpaper: t('defaultWallpaper'),
        themes: {
          system: t('themes.system'),
          light: t('themes.light'),
          pureLight: t('themes.pureLight'),
          dark: t('themes.dark'),
          pureDark: t('themes.pureDark'),
        },
        themeGroups: {
          kortix: t('themes.kortix'),
          lightThemes: t('themes.lightThemes'),
          darkThemes: t('themes.darkThemes'),
        },
        themeSearch: {
          placeholder: t('themes.search'),
          empty: t('themes.noResults'),
        },
        densities: {
          normal: {
            label: t('densities.normal.label'),
            description: t('densities.normal.description'),
          },
          minimal: {
            label: t('densities.minimal.label'),
            description: t('densities.minimal.description'),
          },
        },
        wallpapers: {
          dither: t('wallpapers.dither'),
          brandmark: t('wallpapers.brandmark'),
          nebula: t('wallpapers.nebula'),
          silk: t('wallpapers.silk'),
          grain: t('wallpapers.grain'),
          neuro: t('wallpapers.neuro'),
          blank: t('wallpapers.blank'),
        },
      }}
      theme={selected}
      onThemeChange={select}
      themeChoice={choice}
      wallpaperId={wallpaperId}
      isLightTheme={resolvedTheme === 'light'}
      onWallpaperSelect={setWallpaperId}
      conversationDensity={conversationDensity}
      onConversationDensityChange={setConversationDensity}
      genuiEnabled={genuiEnabled}
      onGenuiEnabledChange={setGenuiEnabled}
    />
  );
}
