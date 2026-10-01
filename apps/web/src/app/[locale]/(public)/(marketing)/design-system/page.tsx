'use client';

import { useTranslations } from '@/i18n/use-translations';

import { cn } from '@/lib/utils';
import {
  WarningCircleIcon as AlertCircle,
  WarningIcon as AlertTriangle,
  ArrowRightIcon as ArrowRight,
  TextBIcon as Bold,
  CheckIcon as Check,
  CaretUpDownIcon as ChevronsUpDown,
  CopyIcon as Copy,
  GitBranchIcon as FolderGit2,
  QuestionIcon as HelpCircle,
  InfoIcon as Info,
  EnvelopeIcon as Mail,
  PlusIcon as Plus,
  MagnifyingGlassIcon as Search,
  GearSixIcon as Settings,
  SmileyIcon as Smiley,
  StarIcon as Star,
  TrashIcon as Trash2,
  WarningIcon as TriangleAlert,
  UsersIcon as Users,
  XIcon as X,
} from '@phosphor-icons/react';
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import {
  Alert,
  AlertContent,
  AlertDescription,
  AlertMedia,
  AlertTitle,
} from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { CheckboxGroup, CheckboxGroupItem } from '@/components/ui/checkbox-group';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { DefinitionList, DefinitionRow } from '@/components/ui/definition-list';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { EmojiPicker, type EmojiSelection } from '@/components/ui/emoji-picker';
import { EntityAvatar } from '@/components/ui/entity-avatar';
import { FadedScrollArea } from '@/components/ui/faded-scroll-area';
import { type GlyphSelection } from '@/components/ui/glyph-picker';
import { glyphComponent } from '@/components/ui/glyph-registry';
import { glyphForeground, glyphTint, glyphTintHover } from '@/components/ui/glyph-tint';
import { InfoBanner } from '@/components/ui/info-banner';
import { InlineMeta } from '@/components/ui/inline-meta';
import { Input } from '@/components/ui/input';
import { Kbd, KbdGroup } from '@/components/ui/kbd';
import { IconInbox } from '@/components/ui/kortix-icons';
import { Label } from '@/components/ui/label';
import Loading from '@/components/ui/loading';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
  ModalTrigger,
} from '@/components/ui/modal';
import { PageSearchBar } from '@/components/ui/page-search-bar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Progress } from '@/components/ui/progress';
import { ProjectIconPicker } from '@/components/ui/project-icon-picker';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Section as BrandSection } from '@/components/ui/section';
import { Separator } from '@/components/ui/separator';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Slider } from '@/components/ui/slider';
import { SpotlightCard } from '@/components/ui/spotlight-card';
import { DiffStat, StatusBadge, StatusDot } from '@/components/ui/status';
import { Switch } from '@/components/ui/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsListCompact,
  TabsTrigger,
  TabsTriggerCompact,
} from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import {
  errorToast,
  infoToast,
  loadingToast,
  successToast,
  warningToast,
} from '@/components/ui/toast';
import { Toggle } from '@/components/ui/toggle';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { UserAvatar } from '@/components/ui/user-avatar';
import { EmptyState } from '@/features/layout/section/empty-state';
import { DESIGN_SYSTEM_TRANSLATION_KEYS } from '@/i18n/design-system-translation-keys.generated';
import { localizeUiCatalog } from '@/i18n/localize-ui-catalog';
import { WALLPAPER_DOWNLOADS, type WallpaperDownload } from '@/lib/wallpaper-downloads';
import {
  PlugsConnectedIcon as Cable,
  CloudIcon,
  GithubLogoIcon,
  PlugIcon as Plug,
  RadioIcon as Radio,
  LightningIcon as Zap,
} from '@phosphor-icons/react';

import { CardSection } from './card-section';
import { ConfettiSection } from './confetti-section';
import { IconsSection } from './icons-section';
import {
  AccentRow,
  MotionBar,
  SpacingBase,
  SpacingRow,
  TokenSwatch,
  TypeRow,
} from './live-tokens';
import { DropdownDemos, SelectDemos } from './menu-demos';
import { Download } from '@/features/icon/icons/download';

// Filtered once at module load — the catalog is a static constant, so the
// per-render filter().map() chain in the JSX collapses to a single map.
const MARK_WALLPAPERS = WALLPAPER_DOWNLOADS.filter((w) => w.group === 'mark');
const PRODUCT_WALLPAPERS = WALLPAPER_DOWNLOADS.filter((w) => w.group === 'product');

/**
 * Token NAMES only. No value lives in this file: every swatch is painted with
 * `var(--token)` and the value beside it is read with getComputedStyle in
 * `live-tokens.tsx`. Values come from `globals.css`, which is generated from
 * `.agents/skills/kortix-brand/references/visual/visual-system.json`.
 */

/** The surface ladder, by depth (kit `color.md`, "Surface ladder"). */
const SURFACE_LADDER = [
  { role: 'canvas', token: '--background', note: 'The page itself.' },
  { role: 'pane', token: '--pane', note: 'The content pane inside the app shell.' },
  { role: 'shell', token: '--surface', note: 'A full-bleed pane that stands in for the page.' },
  { role: 'surface-1', token: '--card', note: 'Lifted region, sidebar, hover surface.' },
  { role: 'surface-2', token: '--secondary', note: 'Inset controls, chips, track wells.' },
  { role: 'top surface', token: '--popover', note: 'Overlays, fields, panels inside a panel.' },
  { role: 'ink', token: '--foreground', note: 'Primary text.' },
  { role: 'ink-muted', token: '--muted-foreground', note: 'Descriptions, meta, idle state.' },
  { role: 'hairline', token: '--border', note: 'Every content border.' },
] as const;

/** Every other semantic token the product reads. */
const SEMANTIC_TOKENS = [
  { name: 'Primary', token: '--primary' },
  { name: 'Primary Foreground', token: '--primary-foreground' },
  { name: 'Card Foreground', token: '--card-foreground' },
  { name: 'Popover Foreground', token: '--popover-foreground' },
  { name: 'Muted', token: '--muted' },
  { name: 'Accent', token: '--accent' },
  { name: 'Accent Foreground', token: '--accent-foreground' },
  { name: 'Secondary Foreground', token: '--secondary-foreground' },
  { name: 'Input', token: '--input' },
  { name: 'Ring', token: '--ring' },
  { name: 'Hover', token: '--hover' },
  { name: 'Active', token: '--active' },
  { name: 'Destructive', token: '--destructive' },
  { name: 'Destructive Foreground', token: '--destructive-foreground' },
  { name: 'Sidebar', token: '--sidebar' },
  { name: 'Sidebar Row', token: '--sidebar-row' },
  { name: 'Sidebar Row Control', token: '--sidebar-row-control' },
  { name: 'Sidebar Border', token: '--sidebar-border' },
] as const;

/**
 * The only sources of hue in product UI (kit decision D5). The classes are
 * written out in full so Tailwind compiles them.
 */
const ACCENTS = [
  {
    name: 'kortix-base',
    token: '--kortix-base',
    meaning: 'Brand, focus, links. Aliases --ring.',
    dot: 'bg-kortix-base',
    tint: 'bg-kortix-base/15',
  },
  {
    name: 'kortix-green',
    token: '--kortix-green',
    meaning: 'success, running, connected, merged',
    dot: 'bg-kortix-green',
    tint: 'bg-kortix-green/15',
  },
  {
    name: 'kortix-red',
    token: '--kortix-red',
    meaning: 'error, failed',
    dot: 'bg-kortix-red',
    tint: 'bg-kortix-red/15',
  },
  {
    name: 'kortix-orange',
    token: '--kortix-orange',
    meaning: 'warning, needs attention',
    dot: 'bg-kortix-orange',
    tint: 'bg-kortix-orange/15',
  },
  {
    name: 'kortix-yellow',
    token: '--kortix-yellow',
    meaning: 'pending',
    dot: 'bg-kortix-yellow',
    tint: 'bg-kortix-yellow/15',
  },
  {
    name: 'kortix-blue',
    token: '--kortix-blue',
    meaning: 'info, open, in review',
    dot: 'bg-kortix-blue',
    tint: 'bg-kortix-blue/15',
  },
  {
    name: 'kortix-purple',
    token: '--kortix-purple',
    meaning: 'Reserved. No default meaning. Do not assign one.',
    dot: 'bg-kortix-purple',
    tint: 'bg-kortix-purple/15',
  },
] as const;

/** Chart ramp: data visualization only. Read through `var(--chart-n)`. */
const CHART_TOKENS = ['--chart-1', '--chart-2', '--chart-3', '--chart-4', '--chart-5'] as const;

type LogoFormat = 'svg' | 'png';

/** Kit vocabulary (D6): symbol = the mark alone, logo = symbol + wordmark, brandmark-bg = the outline wallpaper. */
type LogoKind = 'symbol' | 'logo' | 'brandmark-bg';

interface LogoAsset {
  id: string;
  kind: LogoKind;
  label: string;
  variant: string;
  svgSrc: string;
  /** Absent for brandmark-bg: it ships as SVG only. */
  pngSrc?: string;
  dark: boolean;
}

const LOGO_ASSETS: LogoAsset[] = [
  {
    id: 'symbol-black',
    kind: 'symbol',
    label: 'Symbol',
    variant: 'Black',
    svgSrc: '/brandkit/Logo/Brandmark/SVG/Brandmark Black.svg',
    pngSrc: '/brandkit/Logo/Brandmark/PNG/Brandmark Black.png',
    dark: false,
  },
  {
    id: 'symbol-white',
    kind: 'symbol',
    label: 'Symbol',
    variant: 'White',
    svgSrc: '/brandkit/Logo/Brandmark/SVG/Brandmark White.svg',
    pngSrc: '/brandkit/Logo/Brandmark/PNG/Brandmark White.png',
    dark: true,
  },
  {
    id: 'logo-black',
    kind: 'logo',
    label: 'Logo',
    variant: 'Black',
    svgSrc: '/brandkit/Logo/Logomark/SVG/Logomark Black.svg',
    pngSrc: '/brandkit/Logo/Logomark/PNG/Logomark Black.png',
    dark: false,
  },
  {
    id: 'logo-white',
    kind: 'logo',
    label: 'Logo',
    variant: 'White',
    svgSrc: '/brandkit/Logo/Logomark/SVG/Logomark White.svg',
    pngSrc: '/brandkit/Logo/Logomark/PNG/Logomark White.png',
    dark: true,
  },
  {
    id: 'brandmark-bg',
    kind: 'brandmark-bg',
    label: 'brandmark-bg',
    variant: 'White outline',
    svgSrc: '/kortix-brandmark-bg.svg',
    dark: true,
  },
];

/** Asset names for the vocabulary note: the term, and the file that carries it. */
const LOGO_VOCABULARY = [
  { term: 'symbol', file: 'brandkit/Logo/Brandmark/' },
  { term: 'logo', file: 'brandkit/Logo/Logomark/' },
  { term: 'brandmark-bg', file: 'kortix-brandmark-bg.svg' },
] as const;

/**
 * The black mark files need a white ground, whatever the page theme. Named
 * constant on purpose (kit color.md, "Escape hatches": the asset is not ours to
 * recolor). The dark ground is a token scope: `dark` re-declares the tokens.
 */
const LOGO_GROUND_LIGHT = 'bg-white';
const LOGO_GROUND_DARK = 'dark bg-background';

interface SocialAsset {
  id: string;
  variant: string;
  /** Square 1:1 profile-picture style PNG — symbol centred on a solid field. */
  pngSrc: string;
  dark: boolean;
}

/** Ready-to-use social avatars: the symbol centred on a solid field, square 1:1. */
const SOCIAL_ASSETS: SocialAsset[] = [
  {
    id: 'social-black',
    variant: 'Black',
    pngSrc: '/brandkit/Profile Picture/Avatar Black.png',
    dark: true,
  },
  {
    id: 'social-white',
    variant: 'White',
    pngSrc: '/brandkit/Profile Picture/Avatar White.png',
    dark: false,
  },
];

/**
 * Type rungs. Name and role only: the size is read from `--text-<step>` at
 * runtime. Roles follow the kit's `typography.md` ("The scale").
 */
const TYPE_STEPS = [
  { step: 'xs', role: 'Meta, captions, row descriptions: the workhorse' },
  { step: 'sm', role: 'Body, row titles, labels, button text' },
  { step: 'md', role: 'Do not add uses', legacy: 'Non-canonical' },
  { step: 'base', role: 'Long-form prose only' },
  { step: 'lg', role: 'Rare sub-heading' },
  { step: 'xl', role: 'Section page title' },
  { step: '2xl', role: 'Detail-view title. App ceiling.' },
  { step: '3xl', role: 'Display. Marketing and decks only.' },
  { step: '4xl', role: 'Display. Marketing and decks only.' },
  { step: '5xl', role: 'Display. Marketing and decks only.' },
  { step: '6xl', role: 'Hero. Marketing and decks only.' },
  { step: '7xl', role: 'Hero. Marketing ceiling.' },
  { step: '8xl', role: 'Hero numerals. Marketing and decks only.' },
] as const;

/**
 * Duration utilities, written in full so Tailwind compiles them. The readout
 * in `MotionBar` is the computed transition, so a dead utility shows up here
 * as the 150ms default.
 */
const DURATIONS = [
  { name: 'duration-fast', cls: 'duration-fast', use: 'Hover color and opacity' },
  { name: 'duration-normal', cls: 'duration-normal', use: 'The default UI transition' }, // audit:allow prose uses the word transition
  { name: 'duration-moderate', cls: 'duration-moderate', use: 'Disclosure, accordion, tab' },
  { name: 'duration-slow', cls: 'duration-slow', use: 'Modal, drawer, sheet. The product ceiling.' },
  { name: 'duration-slower', cls: 'duration-slower', use: 'Marketing and decks only' },
] as const;

const EASING_CURVES = [
  { name: 'ease-out', cls: 'ease-out', note: 'Enter and exit. Reach here first.' },
  { name: 'ease-in-out', cls: 'ease-in-out', note: 'On-screen elements that move or morph.' },
  { name: 'ease-default', cls: 'ease-default', note: 'The Kortix house curve.' },
  { name: 'ease-in', cls: 'ease-in', note: 'Banned. Starts slow, so the UI feels sluggish.' }, // audit:allow data row that names the banned curve
] as const;

/** Primitives and patterns the brand kit bans (`kortix-design-system`, "Do not use"). */
const BANNED_PATTERNS = [
  {
    name: 'SectionCard',
    why: 'A second panel system beside Card.',
    instead: 'Card, or a bg-popover rounded-md border panel',
  },
  {
    name: 'List / ListRow',
    why: 'A divider-separated list is a second row system.',
    instead: 'a ul with space-y-2 and entity row classes',
  },
  {
    name: 'Stagger mount',
    why: 'The delay is charged to the user on every visit.',
    instead: 'no delay: every item appears at once',
  },
] as const;

/** Spacing steps. Width is `calc(var(--spacing) * step)`; the px is measured. */
const SPACING_STEPS = [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 5, 6, 8, 10, 12, 16, 20, 24] as const;

const SHADOW_SCALE: ReadonlyArray<{
  label: string;
  cssVar: string;
  use: string;
  twClass?: string;
}> = [
  {
    label: 'shadow-xs',
    twClass: 'shadow-xs',
    cssVar: '--shadow-xs',
    use: 'Chips, slider thumbs, glass panels',
  },
  {
    label: 'shadow-sm',
    twClass: 'shadow-sm',
    cssVar: '--shadow-sm',
    use: 'Tabs, sticky bars, hover lift',
  },
  {
    label: 'shadow-md',
    twClass: 'shadow-md',
    cssVar: '--shadow-md',
    use: 'Dropdowns, selects, popovers',
  },
  {
    label: 'shadow-lg',
    twClass: 'shadow-lg',
    cssVar: '--shadow-lg',
    use: 'Modals, sheets, toasts',
  },
  {
    label: 'shadow-xl',
    twClass: 'shadow-xl',
    cssVar: '--shadow-xl',
    use: 'Command palette, floating windows',
  },
];

const TOC_SECTIONS = [
  { id: 'hero', label: 'Overview' },
  { id: 'logo', label: 'Logo' },
  { id: 'wallpapers', label: 'Wallpapers' },
  { id: 'colors', label: 'Colors' },
  { id: 'typography', label: 'Typography' },
  { id: 'motion', label: 'Motion' },
  { id: 'spacing', label: 'Spacing' },
  { id: 'shadows', label: 'Shadows' },
  {
    id: 'components',
    label: 'Components',
    children: [
      { id: 'comp-button', label: 'Button' },
      { id: 'comp-badge', label: 'Badge' },
      { id: 'comp-card', label: 'Card' },
      { id: 'comp-input', label: 'Input' },
      { id: 'comp-textarea', label: 'Textarea' },
      { id: 'comp-select', label: 'Select' },
      { id: 'comp-dropdown', label: 'Dropdown' },
      { id: 'comp-checkbox', label: 'Checkbox Group' },
      { id: 'comp-switch', label: 'Switch' },
      { id: 'comp-toggle', label: 'Toggle' },
      { id: 'comp-radio', label: 'Radio Group' },
      { id: 'comp-tabs', label: 'Tabs' },
      { id: 'comp-dialog', label: 'Dialog' },
      { id: 'comp-modal', label: 'Modal' },
      { id: 'comp-sheet', label: 'Sheet' },
      { id: 'comp-tooltip', label: 'Tooltip' },
      { id: 'comp-popover', label: 'Popover' },
      { id: 'comp-emoji-picker', label: 'Emoji Picker' },
      { id: 'comp-project-icon-picker', label: 'Project Icon Picker' },
      { id: 'comp-alert', label: 'Alert' },
      { id: 'comp-toast', label: 'Toast' },
      { id: 'comp-alert-dialog', label: 'Alert Dialog' },
      { id: 'comp-accordion', label: 'Accordion' },
      { id: 'comp-collapsible', label: 'Collapsible' },
      { id: 'comp-separator', label: 'Separator' },
      { id: 'comp-skeleton', label: 'Skeleton' },
      { id: 'comp-progress', label: 'Progress' },
      { id: 'comp-slider', label: 'Slider' },
      { id: 'comp-label', label: 'Label' },
      { id: 'comp-kbd', label: 'Kbd' },
      { id: 'comp-breadcrumb', label: 'Breadcrumb' },
      { id: 'comp-table', label: 'Table' },
      { id: 'comp-calendar', label: 'Calendar' },
      { id: 'comp-scrollarea', label: 'Scroll Area' },
    ],
  },
  {
    id: 'page-patterns',
    label: 'Page Patterns',
    children: [
      { id: 'pat-spotlight-card', label: 'SpotlightCard' },
      { id: 'pat-search-bar', label: 'PageSearchBar' },
    ],
  },
  {
    id: 'patterns',
    label: 'Primitives',
    children: [
      { id: 'pat-page-shell', label: 'PageShell' },
      { id: 'pat-section', label: 'Section' },
      { id: 'pat-banned', label: 'Banned patterns' },
      { id: 'pat-avatars', label: 'Avatars' },
      { id: 'pat-definition-list', label: 'DefinitionList' },
      { id: 'pat-inline-meta', label: 'InlineMeta' },
      { id: 'pat-empty-state', label: 'EmptyState' },
      { id: 'pat-info-banner', label: 'InfoBanner' },
      { id: 'pat-status', label: 'Status (Dot, Badge, Diff)' },
    ],
  },
  { id: 'anti-patterns', label: 'Anti-Patterns' },
  { id: 'usage', label: 'Usage' },
  { id: 'icons', label: 'Icons' },
  { id: 'confetti', label: 'Confetti' },
] as const;

/* All section IDs flattened for intersection observer */
const ALL_SECTION_IDS = TOC_SECTIONS.flatMap((s) =>
  'children' in s && s.children ? [s.id, ...s.children.map((c) => c.id)] : [s.id],
);

function LogoCard({ asset, fmt }: { asset: LogoAsset; fmt: LogoFormat }) {
  const isWide = asset.kind !== 'symbol';
  // brandmark-bg ships as SVG only: the PNG toggle falls back to the SVG file.
  const downloadFmt = fmt === 'png' && asset.pngSrc ? 'png' : 'svg';
  const downloadHref = downloadFmt === 'png' ? asset.pngSrc : asset.svgSrc;
  const downloadName = `kortix-${asset.kind}-${asset.variant.toLowerCase().replace(/\s+/g, '-')}.${downloadFmt}`;

  return (
    <div className="group relative">
      <div
        className={cn(
          'border-border relative flex aspect-[3/2] items-center justify-center overflow-hidden rounded-md border transition-colors',
          isWide ? 'px-6 py-8' : 'p-10',
          asset.dark ? LOGO_GROUND_DARK : LOGO_GROUND_LIGHT,
        )}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={asset.svgSrc}
          alt={`Kortix ${asset.label} ${asset.variant}`}
          className={cn(
            'object-contain',
            asset.kind === 'brandmark-bg'
              ? 'size-full'
              : isWide
                ? 'max-h-8 w-full md:max-h-10'
                : 'max-h-10 w-auto md:max-h-12',
          )}
        />

        <a
          href={downloadHref}
          download={downloadName}
          className="bg-hover absolute inset-0 flex cursor-pointer items-center justify-center rounded-md opacity-0 transition-opacity group-hover:opacity-100"
        >
          <span className="bg-background ring-border flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium shadow-sm ring-1">
            <Download className="size-3" /> {downloadFmt.toUpperCase()}
          </span>
        </a>
      </div>

      <div className="mt-2 flex items-baseline gap-1.5 px-0.5">
        <span className="text-foreground text-xs font-medium">{asset.label}</span>
        <span className="text-muted-foreground font-mono text-xs">{asset.variant}</span>
      </div>
    </div>
  );
}

function SocialCard({ asset }: { asset: SocialAsset }) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const downloadName = `kortix-avatar-${asset.variant.toLowerCase()}.png`;

  return (
    <div className="group relative">
      <div
        className={cn(
          'border-border relative aspect-square overflow-hidden rounded-md border',
        )}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={asset.pngSrc}
          alt={tI18nComplete('text0330aaf3e67a', { value0: asset.variant })}
          className="size-full object-cover"
        />

        <a
          href={asset.pngSrc}
          download={downloadName}
          className="bg-hover absolute inset-0 flex cursor-pointer items-center justify-center rounded-md opacity-0 transition-opacity group-hover:opacity-100"
        >
          <span className="bg-background ring-border flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium shadow-sm ring-1">
            <Download className="size-3" /> PNG
          </span>
        </a>
      </div>

      <div className="mt-2 flex items-baseline gap-1.5 px-0.5">
        <span className="text-foreground text-xs font-medium">
          {tI18nComplete.raw('textca8e826d9c2e')}
        </span>
        <span className="text-muted-foreground font-mono text-xs">{asset.variant}</span>
      </div>
    </div>
  );
}

function formatBytes(bytes: number) {
  return bytes >= 1_000_000
    ? `${(bytes / 1_000_000).toFixed(1)} MB`
    : `${Math.round(bytes / 1000)} KB`;
}

/**
 * One wallpaper in one theme, with a download chip per resolution. The preview
 * is a small JPEG of the same composition the download contains — both come
 * out of `scripts/generate-wallpapers.mjs`, so a card can never advertise a
 * wallpaper that is no longer what you get.
 */
function WallpaperCard({ wallpaper }: { wallpaper: WallpaperDownload }) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const localizedWallpaper = localizeUiCatalog(
    wallpaper,
    tI18nComplete,
    DESIGN_SYSTEM_TRANSLATION_KEYS,
  );
  wallpaper = localizedWallpaper;

  return (
    <div className="group relative">
      <div className="border-border relative aspect-video overflow-hidden rounded-md border">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={wallpaper.preview}
          alt={tI18nComplete('text58432f02cc20', {
            value0: wallpaper.id === 'brandmark' ? 'brandmark-bg' : wallpaper.name,
            value1: wallpaper.theme,
          })}
          className="size-full object-cover"
          loading="lazy"
        />
      </div>

      <div className="mt-2 flex items-baseline gap-1.5 px-0.5">
        <span className="text-foreground text-xs font-medium">
          {wallpaper.id === 'brandmark' ? 'brandmark-bg' : wallpaper.name}
        </span>
        <span className="text-muted-foreground font-mono text-xs capitalize">
          {wallpaper.theme}
        </span>
      </div>

      <div className="mt-1.5 flex flex-wrap gap-1 px-0.5">
        {wallpaper.files.map((f) => (
          <a
            key={f.file}
            href={f.href}
            download={f.file}
            title={`${f.width}×${f.height} · ${formatBytes(f.bytes)}`}
            className="text-muted-foreground hover:text-foreground hover:bg-foreground/[0.04] ring-border inline-flex cursor-pointer items-center gap-1 rounded-full px-2 py-0.5 font-mono text-xs ring-1 transition-colors"
          >
            <Download className="size-2.5 shrink-0" />
            {f.label}
          </a>
        ))}
      </div>
    </div>
  );
}

function FormatToggle({
  value,
  onChange,
}: {
  value: LogoFormat;
  onChange: (v: LogoFormat) => void;
}) {
  return (
    <div className="bg-foreground/[0.05] flex items-center gap-0.5 rounded-full p-0.5">
      {(['svg', 'png'] as const).map((f) => (
        <button
          key={f}
          onClick={() => onChange(f)}
          className={cn(
            'cursor-pointer rounded-full px-3 py-1 font-mono text-xs transition-colors',
            value === f
              ? 'bg-background text-foreground ring-foreground/[0.06] shadow-sm ring-1'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {f.toUpperCase()}
        </button>
      ))}
    </div>
  );
}

function DemoContainer({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={cn('border-border bg-card/10 max-w-full min-w-0 rounded-lg border p-6', className)}
    >
      {children}
    </div>
  );
}

function SectionDivider() {
  return <div className="border-border/50 mt-14 border-t pt-8" />;
}

/**
 * A reference section, collapsed by default. The page opens as an index: the
 * download area (logo, wallpapers) is what you land on, and everything below it
 * is one row per topic until you ask for it. The `id` sits on the item, not the
 * content, so `/design-system#components` still lands here while it is closed —
 * `BrandPage` opens the owning section for any hash or table-of-contents jump.
 */
function CollapsibleSection({
  id,
  label,
  summary,
  children,
}: {
  id: string;
  label: React.ReactNode;
  summary: string;
  children: React.ReactNode;
}) {
  return (
    <AccordionItem id={id} value={id} className="border-border/50 scroll-mt-24 border-b">
      <AccordionTrigger className="min-h-11 items-center gap-6 py-5 hover:no-underline">
        <div className="grid w-full gap-1 sm:grid-cols-12 sm:items-baseline sm:gap-6">
          <span className="text-foreground text-xs tracking-widest uppercase sm:col-span-3">
            {label}
          </span>
          <span className="text-muted-foreground text-sm leading-relaxed font-normal sm:col-span-9">
            {summary}
          </span>
        </div>
      </AccordionTrigger>
      <AccordionContent className="pt-2 pb-16 text-base">{children}</AccordionContent>
    </AccordionItem>
  );
}

function ComponentLabel({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-muted-foreground mb-2 text-xs tracking-widest uppercase">{children}</h3>
  );
}

function ComponentDesc({ children }: { children: React.ReactNode }) {
  return <p className="text-muted-foreground mb-4 text-sm leading-relaxed">{children}</p>;
}

/**
 * EmojiPicker demo — the same composition the create-project modal ships
 * (features/projects/modal/project-icon-field.tsx): an icon-button trigger and
 * the picker in a popover sized to the grid's exact width.
 *
 * Behind a trigger rather than inline on the page, deliberately. The picker
 * fetches ~782 KB of emoji data the first time it mounts, and this is a public
 * marketing route — inline, every visitor would pay for it without opening it.
 */
function EmojiPickerDemo() {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const [open, setOpen] = useState(false);
  const [selection, setSelection] = useState<EmojiSelection | null>(null);

  return (
    <div className="flex items-center gap-3">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label={
              selection
                ? tI18nComplete('text1c01c6630cab', { value0: selection.label })
                : tI18nComplete.raw('textb9edcf16a2bc')
            }
            className="hit-area-1 size-9 shrink-0 transition-[color,background-color,scale] duration-normal active:scale-[0.96]"
          >
            {selection ? (
              // Named by the button's aria-label, so the glyph itself stays out
              // of the accessibility tree.
              <span aria-hidden className="text-lg leading-none">
                {selection.emoji}
              </span>
            ) : (
              <Smiley className="text-muted-foreground size-4" />
            )}
          </Button>
        </PopoverTrigger>
        {/* Exactly as wide as the 9-column grid inside it: 9 cells of size-8 in
            a row padded px-1.5, plus 1px of border per side on a border-box
            surface. p-0 because the picker owns its own padding. */}
        <PopoverContent
          align="start"
          aria-label={tI18nComplete.raw('textb9edcf16a2bc')}
          className="w-[calc(75*var(--spacing)+2px)] overflow-hidden p-0"
        >
          <EmojiPicker
            onEmojiSelect={(emoji) => {
              setSelection(emoji);
              setOpen(false);
            }}
          />
        </PopoverContent>
      </Popover>
      <span className="text-muted-foreground text-sm">
        {selection ? selection.label : tI18nComplete.raw('texte45a9a911fcd')}
      </span>
    </div>
  );
}

/**
 * ProjectIconPicker demo — Emoji and Icon tabs sharing one popover, the same
 * composition Task 9 wires into project-icon-field.tsx. The trigger renders
 * whichever face was picked last; picking from one tab clears the other
 * tab's selection so the trigger never has to arbitrate between two stale
 * picks.
 *
 * Behind a trigger for the same reason as EmojiPickerDemo above: the Emoji
 * tab still mounts frimousse and pays its ~782 KB fetch on first open, and
 * this is a public marketing route.
 */
function ProjectIconPickerDemo() {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const [open, setOpen] = useState(false);
  const [emoji, setEmoji] = useState<EmojiSelection | null>(null);
  const [glyph, setGlyph] = useState<GlyphSelection | null>(null);
  const Glyph = glyph ? glyphComponent(glyph.name) : null;

  return (
    <div className="flex items-center gap-3">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label={
              emoji
                ? tI18nComplete('text1c01c6630cab', { value0: emoji.label })
                : glyph
                  ? tI18nComplete('text1c01c6630cab', { value0: glyph.name })
                  : tI18nComplete.raw('textf2a9bd94c131')
            }
            className={cn(
              'hit-area-1 size-9 shrink-0 transition-[color,background-color,box-shadow,scale] duration-normal active:scale-[0.96]',
              glyph && [glyphTint(glyph.color), glyphTintHover(glyph.color), 'hover:inset-ring-2'],
            )}
          >
            {emoji ? (
              // Named by the button's aria-label, so the glyph itself stays out
              // of the accessibility tree.
              <span aria-hidden className="text-lg leading-none">
                {emoji.emoji}
              </span>
            ) : glyph && Glyph ? (
              <Glyph aria-hidden className={cn('size-4', glyphForeground(glyph.color))} />
            ) : (
              <Smiley className="text-muted-foreground size-4" />
            )}
          </Button>
        </PopoverTrigger>
        {/* Same exact width as EmojiPickerDemo's popover above — both tabs
            inside ProjectIconPicker share the emoji grid's 9-column geometry,
            so the popover never resizes when the Icon tab is selected. */}
        <PopoverContent
          align="start"
          aria-label={tI18nComplete.raw('textf2a9bd94c131')}
          className="w-[calc(75*var(--spacing)+2px)] overflow-hidden p-0"
        >
          <ProjectIconPicker
            onEmojiSelect={(next) => {
              setEmoji(next);
              setGlyph(null);
              setOpen(false);
            }}
            onGlyphSelect={(next) => {
              setGlyph(next);
              setEmoji(null);
              setOpen(false);
            }}
          />
        </PopoverContent>
      </Popover>
      <span className="text-muted-foreground text-sm">
        {emoji ? emoji.label : glyph ? glyph.name : tI18nComplete.raw('texte45a9a911fcd')}
      </span>
    </div>
  );
}

function AntiPatternBlock({
  title,
  bad,
  good,
  description,
}: {
  title: string;
  bad: string;
  good: string;
  description: string;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  return (
    <div className="border-border overflow-hidden rounded-xl border">
      <div className="border-border/30 border-b px-5 py-4">
        <h4 className="text-foreground text-sm font-medium">{title}</h4>
        <p className="text-muted-foreground mt-1 text-xs">{description}</p>
      </div>
      <div className="divide-border/30 grid divide-y md:grid-cols-2 md:divide-x md:divide-y-0">
        <div className="p-4">
          <div className="mb-2.5 flex items-center gap-1.5">
            <X className="text-kortix-red size-3" />
            <span className="text-muted-foreground text-xs font-medium">
              {tHardcodedUi.raw('appHomeDesignSystemPage.line566JsxTextDonAposT')}
            </span>
          </div>
          <pre className="text-muted-foreground bg-muted/30 max-w-full min-w-0 overflow-x-auto rounded-lg p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap">
            {bad}
          </pre>
        </div>
        <div className="p-4">
          <div className="mb-2.5 flex items-center gap-1.5">
            <Check className="text-kortix-green size-3" />
            <span className="text-muted-foreground text-xs font-medium">
              {tHardcodedUi.raw('i18nComplete.text30094e0bec00')}
            </span>
          </div>
          <pre className="text-muted-foreground bg-muted/30 max-w-full min-w-0 overflow-x-auto rounded-lg p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap">
            {good}
          </pre>
        </div>
      </div>
    </div>
  );
}

const TOC_SCROLL_OFFSET = 96;
const TOC_NAV_EDGE_OFFSET = 40;
/** Matches `--animate-accordion-down` in globals.css (0.2s) plus a frame. */
const SECTION_OPEN_MS = 260;

/** Ids that live inside a collapsed section, mapped to the section that owns them. */
const SECTION_OWNER = new Map<string, string>(
  TOC_SECTIONS.flatMap((s): [string, string][] => [
    [s.id, s.id],
    ...('children' in s && s.children ? s.children.map((c): [string, string] => [c.id, s.id]) : []),
  ]),
);

/** The two sections that are always open — this page exists to hand out these files. */
const ALWAYS_OPEN_SECTIONS = new Set(['hero', 'logo', 'wallpapers']);

function owningSection(id: string): string | null {
  const owner = SECTION_OWNER.get(id);
  return owner && !ALWAYS_OPEN_SECTIONS.has(owner) ? owner : null;
}

function scrollActiveTocLinkIntoView(nav: HTMLElement, link: HTMLElement) {
  const navRect = nav.getBoundingClientRect();
  const linkRect = link.getBoundingClientRect();
  const linkTop = linkRect.top - navRect.top + nav.scrollTop;
  const linkBottom = linkTop + linkRect.height;
  const viewTop = nav.scrollTop + TOC_NAV_EDGE_OFFSET;
  const viewBottom = nav.scrollTop + nav.clientHeight - TOC_NAV_EDGE_OFFSET;

  if (linkTop < viewTop) {
    nav.scrollTo({ top: linkTop - TOC_NAV_EDGE_OFFSET, behavior: 'smooth' });
  } else if (linkBottom > viewBottom) {
    nav.scrollTo({
      top: linkBottom - nav.clientHeight + TOC_NAV_EDGE_OFFSET,
      behavior: 'smooth',
    });
  }
}

function TocSidebar({ onNavigate }: { onNavigate: (id: string) => boolean }) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const tocSections = localizeUiCatalog(
    TOC_SECTIONS,
    tI18nComplete,
    DESIGN_SYSTEM_TRANSLATION_KEYS,
  );
  const [activeId, setActiveId] = useState('hero');
  const navRef = useRef<HTMLDivElement>(null);
  const isClickNavigating = useRef(false);

  useEffect(() => {
    let ticking = false;

    const updateActiveSection = () => {
      if (isClickNavigating.current) return;

      let next = ALL_SECTION_IDS[0];
      for (const id of ALL_SECTION_IDS) {
        const el = document.getElementById(id);
        if (el && el.getBoundingClientRect().top <= TOC_SCROLL_OFFSET) {
          next = id;
        }
      }

      setActiveId((prev) => (prev === next ? prev : next));
    };

    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        updateActiveSection();
        ticking = false;
      });
    };

    window.addEventListener('scroll', onScroll, { passive: true });
    updateActiveSection();
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    if (isClickNavigating.current) return;
    const nav = navRef.current;
    if (!nav) return;

    const link = nav.querySelector<HTMLButtonElement>(`button[data-toc-id="${activeId}"]`);
    if (!link) return;

    scrollActiveTocLinkIntoView(nav, link);
  }, [activeId]);

  const handleNavClick = (id: string) => {
    isClickNavigating.current = true;
    setActiveId(id);

    // A target inside a collapsed section has to exist before we can scroll to
    // it, so open the owner first and let the height animation land.
    const justOpened = onNavigate(id);
    const scrollToTarget = () => {
      const el = document.getElementById(id);
      if (!el) return;
      const top = el.getBoundingClientRect().top + window.scrollY - TOC_SCROLL_OFFSET;
      window.scrollTo({ top, behavior: 'smooth' });
    };

    if (justOpened) window.setTimeout(scrollToTarget, SECTION_OPEN_MS);
    else scrollToTarget();

    window.setTimeout(
      () => {
        isClickNavigating.current = false;
      },
      800 + (justOpened ? SECTION_OPEN_MS : 0),
    );
  };

  /* Determine which parent section is active based on the current activeId */
  const activeParentId = tocSections.find((s) => {
    if (s.id === activeId) return true;
    if ('children' in s && s.children) {
      return s.children.some((c) => c.id === activeId);
    }
    return false;
  })?.id;

  return (
    <FadedScrollArea
      fadeColor="from-background"
      ref={navRef}
      className="scrollbar-hide max-h-[calc(100vh-5rem)] w-full scroll-py-10 overflow-y-auto overscroll-y-contain pt-2"
    >
      <ul className="space-y-0.5 pb-32">
        {tocSections.map((s) => {
          const isParentActive = s.id === activeParentId;
          const hasChildren = 'children' in s && s.children;
          return (
            <li key={s.id}>
              <Button
                type="button"
                variant={activeId === s.id ? 'secondary' : 'ghost'}
                data-toc-id={s.id}
                onClick={() => handleNavClick(s.id)}
                className="flex w-full items-center justify-start text-left"
              >
                {s.label}
              </Button>
              {hasChildren && (
                <ul className="border-border/30 mt-0.5 mb-1 ml-2.5 space-y-0 border-l pl-2.5">
                  {s.children.map((c) => (
                    <li key={c.id}>
                      <Button
                        type="button"
                        variant={activeId === c.id ? 'secondary' : 'ghost'}
                        size="sm"
                        data-toc-id={c.id}
                        onClick={() => handleNavClick(c.id)}
                        className="flex w-full items-center justify-start text-left"
                      >
                        {c.label}
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </FadedScrollArea>
  );
}

export default function BrandPage() {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const tHardcodedUi = useTranslations('hardcodedUi');
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const logoAssets = localizeUiCatalog(LOGO_ASSETS, tI18nComplete, DESIGN_SYSTEM_TRANSLATION_KEYS);
  const [logoFmt, setLogoFmt] = useState<LogoFormat>('svg');
  const [checkboxGroupValue, setCheckboxGroupValue] = useState<string[]>(['a']);
  const [switchOn, setSwitchOn] = useState(true);
  const [switchOff, setSwitchOff] = useState(false);
  const [selectedDate, setSelectedDate] = useState<Date | undefined>(new Date());
  const [sliderValue, setSliderValue] = useState([50]);
  const [togglePressed, setTogglePressed] = useState(true);
  const [openSections, setOpenSections] = useState<string[]>([]);

  /**
   * Opens the section that owns `id` if it is closed. Returns true when it had
   * to open one, so the caller knows to wait for the height animation before
   * scrolling. Safe to call for the always-open sections — it is a no-op.
   */
  const revealSection = useCallback(
    (id: string) => {
      const owner = owningSection(id);
      if (!owner) return false;
      if (openSections.includes(owner)) return false;
      setOpenSections((prev) => (prev.includes(owner) ? prev : [...prev, owner]));
      return true;
    },
    [openSections],
  );

  // A deep link must open what it points at: /design-system#comp-button opens
  // Components and scrolls to the button demo, on load and on later hash changes.
  useEffect(() => {
    const followHash = () => {
      const id = window.location.hash.slice(1);
      if (!id) return;
      const opened = revealSection(id);
      window.setTimeout(
        () => {
          const el = document.getElementById(id);
          if (!el) return;
          const top = el.getBoundingClientRect().top + window.scrollY - TOC_SCROLL_OFFSET;
          window.scrollTo({ top, behavior: opened ? 'smooth' : 'auto' });
        },
        opened ? SECTION_OPEN_MS : 0,
      );
    };

    followHash();
    window.addEventListener('hashchange', followHash);
    return () => window.removeEventListener('hashchange', followHash);
  }, [revealSection]);
  const [collapsibleOpen, setCollapsibleOpen] = useState(false);

  return (
    <main className="bg-background min-h-screen w-full">
      <div className="mx-auto w-full max-w-7xl min-w-0 px-6 pt-24 pb-24 sm:pt-20 sm:pb-32 lg:px-0">
        <div className="grid w-full min-w-0 grid-cols-1 items-start gap-14 lg:grid-cols-12">
          <aside className="sticky top-20 hidden max-h-[calc(100vh-5rem)] self-start lg:col-span-3 lg:block">
            <TocSidebar onNavigate={revealSection} />
          </aside>

          <div className="w-full min-w-0 overflow-x-clip lg:col-span-9">
            <section id="hero">
              <div className="mb-3">
                <Badge variant="outline" className="font-mono text-xs">
                  {tI18nHardcoded.raw('i18nComplete.textfa8b919c909d')}
                </Badge>
              </div>
              <h1 className="text-foreground mb-5 text-3xl font-medium tracking-tight sm:text-4xl md:text-5xl">
                {tHardcodedUi.raw('appHomeDesignSystemPage.line700JsxTextBrandAmpDesignSystem')}
              </h1>
              <p className="text-muted-foreground max-w-xl text-base leading-relaxed">
                {tHardcodedUi.raw(
                  'appHomeDesignSystemPage.line703JsxTextLogoAssetsColorPaletteTypographyMotionTokensComponent',
                )}
              </p>
              <div className="mt-6 flex flex-wrap gap-2">
                <Badge variant="secondary">
                  <span className="font-mono">30+</span>{' '}
                  {tI18nHardcoded.raw('i18nComplete.texta150ce221602')}
                </Badge>
                <Badge variant="secondary">
                  {tHardcodedUi.raw('appHomeDesignSystemPage.line714JsxTextOklchColors')}
                </Badge>
                <Badge variant="secondary">
                  {tHardcodedUi.raw('appHomeDesignSystemPage.line715JsxTextRadixPrimitives')}
                </Badge>
              </div>
            </section>

            <section id="logo" className="mt-14">
              <div className="mb-5 flex items-center justify-between">
                <h2 className="text-muted-foreground text-xs tracking-widest uppercase">
                  {tI18nHardcoded.raw('i18nComplete.textd707dc2f1936')}
                </h2>
                <FormatToggle value={logoFmt} onChange={setLogoFmt} />
              </div>
              <p className="text-muted-foreground mb-6 text-base leading-relaxed">
                {tHardcodedUi.raw(
                  'appHomeDesignSystemPage.line728JsxTextTwoFormsTheSymbolAndTheWordmarkEach',
                )}
              </p>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {logoAssets.map((a) => (
                  <LogoCard key={a.id} asset={a} fmt={logoFmt} />
                ))}
              </div>
              <dl className="text-muted-foreground mt-4 flex flex-wrap gap-x-6 gap-y-1 text-xs">
                {LOGO_VOCABULARY.map((v) => (
                  <div key={v.term} className="flex gap-1.5">
                    <dt className="text-foreground font-mono">{v.term}</dt>
                    <dd className="font-mono">{v.file}</dd>
                  </div>
                ))}
              </dl>
              <p className="text-muted-foreground mt-6 text-sm leading-relaxed">
                {tHardcodedUi.raw(
                  'appHomeDesignSystemPage.line737JsxTextTheSymbolIsDerivedFromTheLetterK',
                )}
                {"'"}
                {tHardcodedUi.raw(
                  'appHomeDesignSystemPage.line739JsxTextTPracticalNeverStretchRotateOrRecolorIt',
                )}
              </p>

              {/* Social avatars — symbol centred on a solid field, square 1:1 */}
              <div className="mt-10">
                <h3 className="text-muted-foreground mb-5 text-xs tracking-widest uppercase">
                  {tI18nHardcoded.raw(
                    'autoAppPublicMarketingDesignSystemPageJsxTextSocialAvatar0528fcc8',
                  )}
                </h3>
                <p className="text-muted-foreground mb-6 text-base leading-relaxed">
                  {tI18nHardcoded.raw(
                    'autoAppPublicMarketingDesignSystemPageJsxTextTheSymboleb8e02af',
                  )}{' '}
                  {tI18nHardcoded.raw('i18nComplete.textd7abbd37d0b8')}
                </p>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
                  {SOCIAL_ASSETS.map((a) => (
                    <SocialCard key={a.id} asset={a} />
                  ))}
                </div>
              </div>
            </section>

            <section id="wallpapers">
              <SectionDivider />
              <h2 className="text-muted-foreground mb-5 text-xs tracking-widest uppercase">
                {tI18nHardcoded.raw('i18nComplete.text006547c4fdf5')}
              </h2>
              <p className="text-muted-foreground mb-8 text-base leading-relaxed">
                {tI18nHardcoded.raw('i18nComplete.text63315dd386b3')}{' '}
                <code className="text-foreground font-mono text-sm">
                  scripts/generate-wallpapers.mjs
                </code>{' '}
                {tI18nHardcoded.raw('i18nComplete.textdf6816ae6cb1')}
              </p>

              <div className="mb-10">
                <h3 className="text-muted-foreground mb-2 text-xs tracking-widest uppercase">
                  {tI18nHardcoded.raw('i18nComplete.text090ed4316f1d')}
                </h3>
                <p className="text-muted-foreground mb-6 text-base leading-relaxed">
                  {tI18nHardcoded.raw('i18nComplete.text1a093dfd0cde')}{' '}
                  <strong className="font-medium">
                    {tI18nHardcoded.raw('i18nComplete.textba0e4afa9340')}
                  </strong>{' '}
                  {tI18nHardcoded.raw('i18nComplete.textc2d30e82e60f')}{' '}
                  <strong className="font-medium">
                    {tI18nHardcoded.raw('i18nComplete.textd707dc2f1936')}
                  </strong>{' '}
                  {tI18nHardcoded.raw('i18nComplete.texte53dd7d993e1')}
                </p>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
                  {MARK_WALLPAPERS.map((w) => (
                    <WallpaperCard key={`${w.id}-${w.theme}`} wallpaper={w} />
                  ))}
                </div>
              </div>

              <div>
                <h3 className="text-muted-foreground mb-2 text-xs tracking-widest uppercase">
                  {tI18nHardcoded.raw('i18nComplete.textfb9ef894175c')}
                </h3>
                <p className="text-muted-foreground mb-6 text-base leading-relaxed">
                  {tI18nHardcoded.raw('i18nComplete.text739dadd6f1f5')}
                </p>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
                  {PRODUCT_WALLPAPERS.map((w) => (
                    <WallpaperCard key={`${w.id}-${w.theme}`} wallpaper={w} />
                  ))}
                </div>
              </div>
            </section>

            <Accordion
              type="multiple"
              value={openSections}
              onValueChange={setOpenSections}
              className="border-border/50 mt-14 border-t"
            >
              <CollapsibleSection
                id="colors"
                label={tI18nHardcoded.raw('i18nComplete.text88c45d9e526c')}
                summary={tI18nHardcoded.raw('i18nComplete.textffd43fd60b28')}
              >
                <p className="text-muted-foreground mb-6 text-base leading-relaxed">
                  {tHardcodedUi.raw(
                    'appHomeDesignSystemPage.line751JsxTextBlackAndWhiteIsTheFoundationEachUi',
                  )}
                </p>

                <div className="mb-8">
                  <div className="mb-3 flex items-baseline justify-between">
                    <p className="text-muted-foreground text-xs">
                      {tI18nHardcoded.raw('i18nComplete.textdf42a4d5d353')}
                    </p>
                    <p className="text-muted-foreground font-mono text-xs">
                      {tHardcodedUi.raw('appHomeDesignSystemPage.line794JsxTextGlobalsCssRootDark')}
                    </p>
                  </div>
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                    {SURFACE_LADDER.map((r) => (
                      <TokenSwatch key={r.token} token={r.token} title={r.role} note={r.note} />
                    ))}
                  </div>
                </div>

                <div className="mb-8">
                  <div className="mb-3 flex items-baseline justify-between">
                    <p className="text-muted-foreground text-xs">
                      {tHardcodedUi.raw('appHomeDesignSystemPage.line791JsxTextCorePalette')}
                    </p>
                  </div>
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                    {SEMANTIC_TOKENS.map((token) => (
                      <TokenSwatch key={token.token} token={token.token} title={token.name} />
                    ))}
                  </div>
                </div>

                <div className="mb-8">
                  <p className="text-muted-foreground mb-1 text-xs">Accents and status</p>
                  <p className="text-muted-foreground mb-3 max-w-xl text-xs">
                    The only hues in product UI. They paint glyphs, dots, tints and charts. The
                    label beside them stays foreground or muted-foreground, because every accent
                    fails AA as body text on white. Idle has no hue: muted-foreground.
                  </p>
                  <div className="border-border rounded-md border px-4">
                    {ACCENTS.map((a) => (
                      <AccentRow
                        key={a.token}
                        token={a.token}
                        name={a.name}
                        meaning={a.meaning}
                        dotClass={a.dot}
                        tintClass={a.tint}
                      />
                    ))}
                  </div>
                </div>

                <div>
                  <p className="text-muted-foreground mb-1 text-xs">Chart ramp</p>
                  <p className="text-muted-foreground mb-3 max-w-xl text-xs">
                    Data visualization only. Read it through var(--chart-n), not a utility.
                  </p>
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                    {CHART_TOKENS.map((token) => (
                      <TokenSwatch key={token} token={token} title={token.slice(2)} />
                    ))}
                  </div>
                </div>
              </CollapsibleSection>

              <CollapsibleSection
                id="typography"
                label={tI18nHardcoded.raw('i18nComplete.textcab94aba84f9')}
                summary={tI18nHardcoded.raw('i18nComplete.text0c3397719010')}
              >
                <p className="text-muted-foreground mb-8 text-base leading-relaxed">
                  {tHardcodedUi.raw(
                    'appHomeDesignSystemPage.line848JsxTextRoobertAGeometricSansSerifFontMedium500',
                  )}
                </p>

                <div className="space-y-6">
                  {[
                    {
                      label: tI18nHardcoded.raw('i18nComplete.texte64e02c862bd'),
                      cls: 'font-medium',
                    },
                    {
                      label: tI18nHardcoded.raw('i18nComplete.textb6bcbb175d23'),
                      cls: 'font-normal',
                    },
                  ].map((s) => (
                    <div key={s.label} className="border-border/30 border-b pb-5">
                      <span className="text-muted-foreground mb-2 block font-mono text-xs tracking-widest">
                        {s.label}
                      </span>
                      <p
                        className={cn('text-foreground text-3xl tracking-tight md:text-5xl', s.cls)}
                      >
                        {tHardcodedUi.raw('appHomeDesignSystemPage.line871JsxTextKortixComputer')}
                      </p>
                    </div>
                  ))}
                </div>

                <div className="bg-popover border-border mt-6 rounded-md border p-5 md:p-6">
                  <span className="text-muted-foreground mb-3 block font-mono text-xs">
                    {tHardcodedUi.raw('appHomeDesignSystemPage.line880JsxTextRoobertMono')}
                  </span>
                  <p className="text-foreground font-mono text-lg tracking-tight md:text-2xl">
                    {tHardcodedUi.raw('appHomeDesignSystemPage.line883JsxTextConstAgentNewKortix')}
                  </p>
                  <p className="text-muted-foreground mt-4 font-mono text-xs">
                    {tHardcodedUi.raw(
                      'appHomeDesignSystemPage.line886JsxTextAbcdefghijklmnopqrstuvwxyzAbcdefghijklmnopqrstuvwxyz0123456789',
                    )}
                  </p>
                </div>

                <div className="mt-8">
                  <p className="text-muted-foreground mb-4 text-xs">
                    {tHardcodedUi.raw('appHomeDesignSystemPage.line894JsxTextTypeScale')}
                  </p>
                  <div className="space-y-0">
                    {TYPE_STEPS.map((t) => (
                      <TypeRow
                        key={t.step}
                        step={t.step}
                        role={t.role}
                        muted={'legacy' in t ? t.legacy : undefined}
                        sample={tHardcodedUi.raw(
                          'appHomeDesignSystemPage.line917JsxTextTheQuickBrownFox',
                        )}
                      />
                    ))}
                  </div>
                </div>
              </CollapsibleSection>

              <CollapsibleSection
                id="motion"
                label={tI18nHardcoded.raw('i18nComplete.text8ca344247c18')}
                summary={tI18nHardcoded.raw('i18nComplete.textd1345dc7da98')}
              >
                <p className="text-muted-foreground mb-6 text-base leading-relaxed">
                  {tHardcodedUi.raw(
                    'appHomeDesignSystemPage.line938JsxTextStandardizedDurationAndEasingTokensEnsureEveryTransition',
                  )}
                </p>

                <div className="mb-8">
                  <p className="text-muted-foreground mb-4 text-xs">
                    {tHardcodedUi.raw('appHomeDesignSystemPage.line946JsxTextDurationScale')}
                  </p>
                  <DemoContainer>
                    <div className="space-y-3">
                      {DURATIONS.map((d) => (
                        <MotionBar
                          key={d.name}
                          label={d.name}
                          durationClass={d.cls}
                          easingClass="ease-out"
                          note={d.use}
                        />
                      ))}
                    </div>
                  </DemoContainer>
                </div>

                <div>
                  <p className="text-muted-foreground mb-4 text-xs">
                    {tHardcodedUi.raw('appHomeDesignSystemPage.line964JsxTextEasingCurves')}
                  </p>
                  <DemoContainer>
                    <div className="space-y-3">
                      {EASING_CURVES.map((e) => (
                        <MotionBar
                          key={e.name}
                          label={e.name}
                          durationClass="duration-slow"
                          easingClass={e.cls}
                          note={e.note}
                        />
                      ))}
                    </div>
                  </DemoContainer>
                </div>
              </CollapsibleSection>

              <CollapsibleSection
                id="spacing"
                label={tI18nHardcoded.raw('i18nComplete.text62a822a58309')}
                summary={tI18nHardcoded.raw('i18nComplete.texte2fe1fe9cff1')}
              >
                <p className="text-muted-foreground mb-6 text-base leading-relaxed">
                  {tHardcodedUi.raw(
                    'appHomeDesignSystemPage.line988JsxTextAConsistentSpacingScaleBasedOn4pxIncrements',
                  )}
                </p>

                <DemoContainer>
                  <div className="mb-4">
                    <SpacingBase />
                  </div>
                  <div className="space-y-2.5">
                    {SPACING_STEPS.map((step) => (
                      <SpacingRow key={step} step={step} />
                    ))}
                  </div>
                </DemoContainer>
              </CollapsibleSection>

              <CollapsibleSection
                id="shadows"
                label={tI18nHardcoded.raw('i18nComplete.text2a19bdc09aa3')}
                summary={tI18nHardcoded.raw('i18nComplete.text9d1a9c5808a8')}
              >
                <p className="text-muted-foreground mb-6 text-base leading-relaxed">
                  {tI18nHardcoded.raw(
                    'autoAppPublicMarketingDesignSystemPageJsxTextSubtleElevation8c9f8cda',
                  )}{' '}
                  <code className="bg-muted rounded-sm px-1 font-mono text-xs">box-shadow</code>{' '}
                  {tI18nHardcoded.raw('i18nComplete.textdb482d99cacb')}
                </p>

                <DemoContainer>
                  <div className="bg-muted rounded-md p-8">
                    <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
                      {SHADOW_SCALE.map((s) => (
                        <div key={s.label} className="flex flex-col gap-3">
                          <div
                            className={cn(
                              'bg-card border-border flex h-28 items-center justify-center rounded-md border',
                              s.twClass,
                            )}
                            style={s.twClass ? undefined : { boxShadow: `var(${s.cssVar})` }}
                          >
                            <span className="text-muted-foreground font-mono text-xs">
                              {s.label}
                            </span>
                          </div>
                          <div>
                            <p className="font-mono text-xs">{s.cssVar}</p>
                            <p className="text-muted-foreground mt-0.5 text-xs">{s.use}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </DemoContainer>
              </CollapsibleSection>

              <CollapsibleSection
                id="components"
                label={tI18nHardcoded.raw('i18nComplete.texta150ce221602')}
                summary={tI18nHardcoded.raw('i18nComplete.texta55bc449bcc1')}
              >
                <p className="text-muted-foreground mb-8 text-base leading-relaxed">
                  {tHardcodedUi.raw(
                    'appHomeDesignSystemPage.line1019JsxTextTheCompleteComponentLibraryEachComponentUsesA',
                  )}
                </p>

                <div id="comp-button" className="mb-12">
                  <ComponentLabel>
                    {tI18nHardcoded.raw('i18nComplete.text707eab0c23ec')}
                  </ComponentLabel>
                  <ComponentDesc>
                    10 variants, 8 sizes. Buttons are <code className="bg-muted rounded-sm px-1 font-mono text-xs">rounded-md</code>.
                    Panels, cards and rows are rounded-md too; floating panels are rounded-lg;
                    rounded-2xl is marketing only. The{' '}
                    <code className="bg-muted rounded-sm px-1 font-mono text-xs">destructive</code>{' '}
                    variant is reserved for the one irreversible confirm.
                  </ComponentDesc>
                  <DemoContainer>
                    <div className="space-y-6">
                      <div>
                        <p className="text-muted-foreground mb-3 text-xs tracking-wider uppercase">
                          {tHardcodedUi.raw('appHomeDesignSystemPage.line1039JsxTextBaseVariants')}
                        </p>
                        <div className="flex flex-wrap gap-2">
                          <Button variant="default">
                            {tI18nHardcoded.raw('i18nComplete.text21b111cbfe6e')}
                          </Button>
                          <Button variant="secondary">
                            {tI18nHardcoded.raw('i18nComplete.text62f2ccfffcc5')}
                          </Button>
                          <Button variant="destructive">
                            {tI18nHardcoded.raw('i18nComplete.textc3e58a73609d')}
                          </Button>
                          <Button variant="outline">
                            {tI18nHardcoded.raw('i18nComplete.texteabbf3abaf8d')}
                          </Button>
                          <Button variant="ghost">
                            {tI18nHardcoded.raw('i18nComplete.textdf1bc4984a05')}
                          </Button>
                          <Button variant="link">
                            {tI18nHardcoded.raw('i18nComplete.texta6a32dbc5618')}
                          </Button>
                        </div>
                      </div>
                      <div>
                        <p className="text-muted-foreground mb-3 text-xs tracking-wider uppercase">
                          {tHardcodedUi.raw(
                            'appHomeDesignSystemPage.line1051JsxTextKortixVariants',
                          )}
                        </p>
                        <div className="flex flex-wrap gap-2">
                          <Button variant="secondary">
                            {tI18nHardcoded.raw('i18nComplete.text62f2ccfffcc5')}
                          </Button>
                          <Button variant="muted">
                            {tI18nHardcoded.raw('i18nComplete.text2346f214ad56')}
                          </Button>
                          <Button variant="inverse">
                            {tI18nHardcoded.raw('i18nComplete.textbfe272f94fb0')}
                          </Button>
                          <Button variant="success">
                            {tI18nHardcoded.raw('i18nComplete.textc88a0b907419')}
                          </Button>
                        </div>
                      </div>
                      <div>
                        <p className="text-muted-foreground mb-3 text-xs tracking-wider uppercase">
                          {tHardcodedUi.raw('appHomeDesignSystemPage.line1061JsxTextStandardSizes')}
                        </p>
                        <div className="flex flex-wrap items-center gap-2">
                          <Button size="lg">
                            {tI18nHardcoded.raw('i18nComplete.textab80540d98d2')}
                          </Button>
                          <Button size="default">
                            {tI18nHardcoded.raw('i18nComplete.text21b111cbfe6e')}
                          </Button>
                          <Button size="sm">
                            {tI18nHardcoded.raw('i18nComplete.text5263293fc202')}
                          </Button>
                          <Button size="icon">
                            <Settings className="size-4" />
                          </Button>
                        </div>
                      </div>
                      <div>
                        <p className="text-muted-foreground mb-3 text-xs tracking-wider uppercase">
                          {tHardcodedUi.raw('appHomeDesignSystemPage.line1071JsxTextCompactSizes')}
                        </p>
                        <div className="flex flex-wrap items-center gap-2">
                          <Button size="toolbar" variant="muted">
                            {tI18nHardcoded.raw('i18nComplete.text451aa51a0fb5')}
                          </Button>
                          <Button size="xs" variant="muted">
                            {tI18nHardcoded.raw('i18nComplete.text35542ace70ce')}
                          </Button>
                          <Button size="icon-sm" variant="ghost">
                            <Settings className="size-3.5" />
                          </Button>
                          <Button size="icon-xs" variant="ghost">
                            <X className="size-3" />
                          </Button>
                        </div>
                      </div>
                      <div>
                        <p className="text-muted-foreground mb-3 text-xs tracking-wider uppercase">
                          {tHardcodedUi.raw('appHomeDesignSystemPage.line1081JsxTextWithIcons')}
                        </p>
                        <div className="flex flex-wrap items-center gap-2">
                          <Button>
                            <Mail className="size-4" />
                            {tHardcodedUi.raw('appHomeDesignSystemPage.line1083JsxTextSendEmail')}
                          </Button>
                          <Button variant="outline">
                            <Plus className="size-4" />{' '}
                            {tI18nHardcoded.raw('i18nComplete.text4759498ac2a7')}
                          </Button>
                          <Button variant="secondary">
                            <Search className="size-4" />{' '}
                            {tI18nHardcoded.raw('i18nComplete.text49c266baaaa7')}
                          </Button>
                          <Button variant="destructive">
                            <Trash2 className="size-4" />{' '}
                            {tI18nHardcoded.raw('i18nComplete.texte2d0a54968ea')}
                          </Button>
                          <Button variant="inverse">
                            <ArrowRight className="size-4" />{' '}
                            {tI18nHardcoded.raw('i18nComplete.textccf56ef5db0b')}
                          </Button>
                          <Button variant="success" size="toolbar">
                            <Check className="size-3.5" />{' '}
                            {tI18nHardcoded.raw('i18nComplete.texteebdd24a77d9')}
                          </Button>
                        </div>
                      </div>
                      <div>
                        <p className="text-muted-foreground mb-3 text-xs tracking-wider uppercase">
                          {tI18nHardcoded.raw('i18nComplete.text2f6e9daec8e9')}
                        </p>
                        <div className="flex flex-wrap items-center gap-2">
                          <Button disabled>
                            {tI18nHardcoded.raw('i18nComplete.text75081b593d15')}
                          </Button>
                          <Button disabled variant="outline">
                            {tHardcodedUi.raw(
                              'appHomeDesignSystemPage.line1096JsxTextDisabledOutline',
                            )}
                          </Button>
                          <Button>
                            <Loading className="size-4" />{' '}
                            {tI18nHardcoded.raw('i18nComplete.textdc380888c4e2')}
                          </Button>
                        </div>
                      </div>
                    </div>
                  </DemoContainer>
                </div>

                <div id="comp-badge" className="mb-12">
                  <ComponentLabel>
                    {tI18nHardcoded.raw('i18nComplete.text002474e36821')}
                  </ComponentLabel>
                  <ComponentDesc>
                    {tHardcodedUi.raw(
                      'appHomeDesignSystemPage.line1108JsxTextLabelsStatusIndicatorsAndTagsSevenVariantsFrom',
                    )}
                  </ComponentDesc>
                  <DemoContainer>
                    <div className="space-y-4">
                      <div>
                        <p className="text-muted-foreground mb-3 text-xs tracking-wider uppercase">
                          {tHardcodedUi.raw('appHomeDesignSystemPage.line1114JsxTextBaseVariants')}
                        </p>
                        <div className="flex flex-wrap gap-2">
                          <Badge variant="solid">
                            {tI18nHardcoded.raw('i18nComplete.textb8b311b0f273')}
                          </Badge>
                          <Badge variant="default">
                            {tI18nHardcoded.raw('i18nComplete.text21b111cbfe6e')}
                          </Badge>
                          <Badge variant="secondary">
                            {tI18nHardcoded.raw('i18nComplete.text62f2ccfffcc5')}
                          </Badge>
                          <Badge variant="accent">
                            {tI18nHardcoded.raw('i18nComplete.texta5c6fb18c9af')}
                          </Badge>
                          <Badge variant="destructive">
                            {tI18nHardcoded.raw('i18nComplete.textc3e58a73609d')}
                          </Badge>
                          <Badge variant="outline">
                            {tI18nHardcoded.raw('i18nComplete.texteabbf3abaf8d')}
                          </Badge>
                          <Badge variant="new">
                            {tI18nHardcoded.raw('i18nComplete.text18fdd549b2ed')}
                          </Badge>
                          <Badge variant="beta">
                            {tI18nHardcoded.raw('i18nComplete.text703390318bd5')}
                          </Badge>
                          <Badge variant="highlight">
                            {tI18nHardcoded.raw('i18nComplete.text07ccd15df32a')}
                          </Badge>
                          <Badge variant="transparent">
                            {tI18nHardcoded.raw('i18nComplete.textaac7e89fcd0e')}
                          </Badge>
                        </div>
                      </div>
                      <div>
                        <p className="text-muted-foreground mb-3 text-xs tracking-wider uppercase">
                          {tHardcodedUi.raw(
                            'appHomeDesignSystemPage.line1126JsxTextSemanticStatus',
                          )}
                        </p>
                        <div className="flex flex-wrap gap-2">
                          <Badge variant="success">
                            {tI18nHardcoded.raw('i18nComplete.textc88a0b907419')}
                          </Badge>
                          <Badge variant="badgeSuccess">
                            {tI18nHardcoded.raw(
                              'autoAppPublicMarketingDesignSystemPageJsxTextBadgeSuccessef599436',
                            )}
                          </Badge>
                          <Badge variant="kortix">
                            {tI18nHardcoded.raw('i18nComplete.textc1c1009d3f37')}
                          </Badge>
                          <Badge variant="warning">
                            {tI18nHardcoded.raw('i18nComplete.texte981ddae45d8')}
                          </Badge>
                          <Badge variant="info">
                            {tI18nHardcoded.raw('i18nComplete.text170322a32f3c')}
                          </Badge>
                          <Badge variant="muted">
                            {tI18nHardcoded.raw('i18nComplete.text2346f214ad56')}
                          </Badge>
                        </div>
                      </div>
                      <div>
                        <p className="text-muted-foreground mb-3 text-xs tracking-wider uppercase">
                          {tI18nHardcoded.raw('i18nComplete.text74a3978d1004')}
                        </p>
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge variant="default">
                            {tI18nHardcoded.raw('i18nComplete.text21b111cbfe6e')}
                          </Badge>
                          <Badge variant="default" size="sm">
                            {tI18nHardcoded.raw('i18nComplete.text5263293fc202')}
                          </Badge>
                          <Badge variant="default" size="xs">
                            {tI18nHardcoded.raw('i18nComplete.text35542ace70ce')}
                          </Badge>
                          <Badge variant="secondary" size="tabular">
                            9
                          </Badge>
                          <Badge variant="secondary" size="tabular">
                            12
                          </Badge>
                          <Badge variant="success" size="sm">
                            {tI18nHardcoded.raw('i18nComplete.text92340695899b')}
                          </Badge>
                          <Badge variant="warning" size="sm">
                            {tI18nHardcoded.raw('i18nComplete.text331551b0de41')}
                          </Badge>
                        </div>
                      </div>
                      <div>
                        <p className="text-muted-foreground mb-3 text-xs tracking-wider uppercase">
                          {tHardcodedUi.raw('appHomeDesignSystemPage.line1144JsxTextWithIcons')}
                        </p>
                        <div className="flex flex-wrap gap-2">
                          <Badge variant="default">
                            <Star className="size-3" />
                            {tI18nHardcoded.raw('i18nComplete.textc533cafab69e')}
                          </Badge>
                          <Badge variant="success">
                            <Check className="size-3" />
                            {tI18nHardcoded.raw('i18nComplete.text4f7838402f37')}
                          </Badge>
                          <Badge variant="info">
                            <Info className="size-3" />
                            {tI18nHardcoded.raw('i18nComplete.texta6fd69e48a48')}
                          </Badge>
                          <Badge variant="warning">
                            <AlertTriangle className="size-3" />
                            {tI18nHardcoded.raw('i18nComplete.text331551b0de41')}
                          </Badge>
                        </div>
                      </div>
                    </div>
                  </DemoContainer>
                </div>

                <div id="comp-card" className="mb-12">
                  <ComponentLabel>
                    {tI18nHardcoded.raw('i18nComplete.textbe3702e3f1af')}
                  </ComponentLabel>
                  <ComponentDesc>
                    {tI18nHardcoded.raw('i18nComplete.text4e37aaf3f5f2')}
                  </ComponentDesc>
                  <CardSection />
                </div>

                <div id="comp-input" className="mb-12">
                  <ComponentLabel>
                    {tI18nHardcoded.raw('i18nComplete.text36ecb4f86691')}
                  </ComponentLabel>
                  <ComponentDesc>
                    {tHardcodedUi.raw(
                      'appHomeDesignSystemPage.line1211JsxTextTextInputForFormsAndSearchTheCanonical',
                    )}
                  </ComponentDesc>
                  <DemoContainer>
                    <div className="max-w-sm space-y-4">
                      <div className="space-y-2">
                        <Label htmlFor="demo-input">
                          {tI18nHardcoded.raw('i18nComplete.text0e66373f45dc')}
                        </Label>
                        <Input
                          type="text"
                          id="demo-input"
                          placeholder={tHardcodedUi.raw(
                            'appHomeDesignSystemPage.line1221JsxAttrPlaceholderDefaultInput',
                          )}
                        />
                      </div>
                      <Input
                        type="text"
                        placeholder={tHardcodedUi.raw(
                          'appHomeDesignSystemPage.line1224JsxAttrPlaceholderWithPlaceholder',
                        )}
                      />
                      <Input
                        type="password"
                        placeholder={tHardcodedUi.raw(
                          'appHomeDesignSystemPage.line1225JsxAttrPlaceholderPasswordInput',
                        )}
                      />
                      <Input
                        type="text"
                        disabled
                        placeholder={tI18nHardcoded.raw('i18nComplete.text75081b593d15')}
                      />
                    </div>
                  </DemoContainer>
                </div>

                <div id="comp-textarea" className="mb-12">
                  <ComponentLabel>
                    {tI18nHardcoded.raw('i18nComplete.text467065a16a2e')}
                  </ComponentLabel>
                  <ComponentDesc>
                    {tHardcodedUi.raw(
                      'appHomeDesignSystemPage.line1235JsxTextMultiLineTextInputForLongerContentShares',
                    )}
                  </ComponentDesc>
                  <DemoContainer>
                    <div className="max-w-sm space-y-4">
                      <Textarea
                        placeholder={tHardcodedUi.raw(
                          'appHomeDesignSystemPage.line1241JsxAttrPlaceholderWriteSomething',
                        )}
                      />
                      <Textarea
                        disabled
                        placeholder={tHardcodedUi.raw(
                          'appHomeDesignSystemPage.line1242JsxAttrPlaceholderDisabledTextarea',
                        )}
                      />
                    </div>
                  </DemoContainer>
                </div>

                <div id="comp-select" className="mb-12">
                  <ComponentLabel>
                    {tI18nHardcoded.raw('i18nComplete.text2a78025de6aa')}
                  </ComponentLabel>
                  <ComponentDesc>
                    {tHardcodedUi.raw(
                      'appHomeDesignSystemPage.line1251JsxTextDropdownSelectionFromAListOfOptionsMatches',
                    )}
                  </ComponentDesc>
                  <DemoContainer>
                    <SelectDemos />
                  </DemoContainer>
                </div>

                <div id="comp-dropdown" className="mb-12">
                  <ComponentLabel>
                    {tHardcodedUi.raw('appHomeDesignSystemPage.line1526JsxTextDropdownMenu')}
                  </ComponentLabel>
                  <ComponentDesc>
                    {tHardcodedUi.raw(
                      'appHomeDesignSystemPage.line1528JsxTextContextualMenuTriggeredByAButtonRowsStay',
                    )}{' '}
                    <strong>{tI18nHardcoded.raw('i18nComplete.text7e2372f4115c')}</strong>
                    {tHardcodedUi.raw(
                      'appHomeDesignSystemPage.line1529JsxTextEvenDestructiveOnesLikeDeleteOrRemoveRed',
                    )}
                  </ComponentDesc>
                  <DemoContainer>
                    <DropdownDemos />
                  </DemoContainer>
                </div>

                <div id="comp-checkbox" className="mb-12">
                  <ComponentLabel>
                    {tI18nHardcoded.raw(
                      'autoAppPublicMarketingDesignSystemPageJsxTextCheckboxGroupf8961cfb',
                    )}
                  </ComponentLabel>
                  <ComponentDesc>
                    {tHardcodedUi.raw(
                      'appHomeDesignSystemPage.line1276JsxTextToggleForBooleanValues',
                    )}
                  </ComponentDesc>
                  <DemoContainer className="max-w-xs">
                    <CheckboxGroup value={checkboxGroupValue} onValueChange={setCheckboxGroupValue}>
                      <CheckboxGroupItem
                        value="a"
                        id="check-a"
                        label={tI18nHardcoded.raw(
                          'autoAppPublicMarketingDesignSystemPageJsxAttrLabelOption8399dd58',
                        )}
                      />
                      <CheckboxGroupItem
                        value="b"
                        id="check-b"
                        label={tI18nHardcoded.raw(
                          'autoAppPublicMarketingDesignSystemPageJsxAttrLabelOption275da31e',
                        )}
                      />
                      <CheckboxGroupItem
                        value="c"
                        id="check-c"
                        label={tI18nHardcoded.raw(
                          'autoAppPublicMarketingDesignSystemPageJsxAttrLabelOption225b100e',
                        )}
                        disabled
                      />
                    </CheckboxGroup>
                  </DemoContainer>
                </div>

                <div id="comp-switch" className="mb-12">
                  <ComponentLabel>
                    {tI18nHardcoded.raw('i18nComplete.text39921a740bf2')}
                  </ComponentLabel>
                  <ComponentDesc>
                    {tHardcodedUi.raw(
                      'appHomeDesignSystemPage.line1311JsxTextToggleControlForOnOffStates',
                    )}
                  </ComponentDesc>
                  <DemoContainer>
                    <div className="space-y-4">
                      <div className="flex items-center gap-3">
                        <Switch id="switch-on" checked={switchOn} onCheckedChange={setSwitchOn} />
                        <Label htmlFor="switch-on">
                          {tI18nHardcoded.raw('i18nComplete.text130011756125')}
                        </Label>
                      </div>
                      <div className="flex items-center gap-3">
                        <Switch
                          id="switch-off"
                          checked={switchOff}
                          onCheckedChange={setSwitchOff}
                        />
                        <Label htmlFor="switch-off">
                          {tI18nHardcoded.raw('i18nComplete.textca7981b46ecf')}
                        </Label>
                      </div>
                      <div className="flex items-center gap-3">
                        <Switch id="switch-dis" disabled />
                        <Label htmlFor="switch-dis" className="text-muted-foreground">
                          {tI18nHardcoded.raw('i18nComplete.text75081b593d15')}
                        </Label>
                      </div>
                    </div>
                  </DemoContainer>
                </div>

                <div id="comp-toggle" className="mb-12">
                  <ComponentLabel>
                    {tI18nHardcoded.raw('i18nComplete.text3d03a1dea561')}
                  </ComponentLabel>
                  <ComponentDesc>
                    {tHardcodedUi.raw(
                      'appHomeDesignSystemPage.line1348JsxTextATwoStateButtonWithDefaultAndOutline',
                    )}
                  </ComponentDesc>
                  <DemoContainer>
                    <div className="space-y-4">
                      <div>
                        <p className="text-muted-foreground mb-3 text-xs tracking-wider uppercase">
                          {tI18nHardcoded.raw(
                            'autoAppPublicMarketingDesignSystemPageJsxTextIconOnlyf6a2c4ee',
                          )}
                        </p>
                        <div className="flex flex-wrap gap-2">
                          <Toggle
                            variant="default"
                            pressed={togglePressed}
                            onPressedChange={setTogglePressed}
                            aria-label={tHardcodedUi.raw(
                              'appHomeDesignSystemPage.line1356JsxAttrAriaLabelToggleBold',
                            )}
                          >
                            <Bold className="size-4" />
                          </Toggle>
                          <Toggle
                            variant="outline"
                            aria-label={tHardcodedUi.raw(
                              'appHomeDesignSystemPage.line1360JsxAttrAriaLabelToggleSettings',
                            )}
                          >
                            <Settings className="size-4" />
                          </Toggle>
                        </div>
                      </div>
                      <div>
                        <p className="text-muted-foreground mb-3 text-xs tracking-wider uppercase">
                          {tI18nHardcoded.raw(
                            'autoAppPublicMarketingDesignSystemPageJsxTextTextOnly458d5129',
                          )}
                        </p>
                        <div className="flex flex-wrap gap-2">
                          <Toggle variant="default">
                            {tI18nHardcoded.raw('i18nComplete.text94fee62e68e2')}
                          </Toggle>
                          <Toggle variant="outline">
                            {tI18nHardcoded.raw('i18nComplete.text66f4804ee23d')}
                          </Toggle>
                          <Toggle variant="secondary">
                            {tI18nHardcoded.raw('i18nComplete.textf20c87946555')}
                          </Toggle>
                        </div>
                      </div>
                      <div>
                        <p className="text-muted-foreground mb-3 text-xs tracking-wider uppercase">
                          {tI18nHardcoded.raw(
                            'autoAppPublicMarketingDesignSystemPageJsxTextTextIconc6453fac',
                          )}
                        </p>
                        <div className="flex flex-wrap gap-2">
                          <Toggle variant="default">
                            <Bold className="size-4" />
                            {tI18nHardcoded.raw('i18nComplete.text94fee62e68e2')}
                          </Toggle>
                          <Toggle variant="outline">
                            <Star className="size-4" />
                            {tI18nHardcoded.raw('i18nComplete.text07a2d579c3f0')}
                          </Toggle>
                          <Toggle variant="secondary">
                            <Check className="size-4" />
                            {tI18nHardcoded.raw('i18nComplete.text57fd7a0cf33f')}
                          </Toggle>
                          <Toggle variant="outline">
                            <Settings className="size-4" />
                            {tI18nHardcoded.raw('i18nComplete.text74a883a037bc')}
                          </Toggle>
                        </div>
                      </div>
                    </div>
                  </DemoContainer>
                </div>

                <div id="comp-radio" className="mb-12">
                  <ComponentLabel>
                    {tHardcodedUi.raw('appHomeDesignSystemPage.line1369JsxTextRadioGroup')}
                  </ComponentLabel>
                  <ComponentDesc>
                    {tHardcodedUi.raw(
                      'appHomeDesignSystemPage.line1371JsxTextSingleSelectionFromASetOfOptions',
                    )}
                  </ComponentDesc>
                  <DemoContainer className="max-w-xs">
                    <RadioGroup defaultValue="default">
                      <RadioGroupItem
                        value="default"
                        id="r1"
                        label={tI18nHardcoded.raw('i18nComplete.text21b111cbfe6e')}
                      />
                      <RadioGroupItem
                        value="comfortable"
                        id="r2"
                        label={tI18nHardcoded.raw('i18nComplete.text459a23a5980f')}
                      />
                      <RadioGroupItem
                        value="compact"
                        id="r3"
                        label={tI18nHardcoded.raw('i18nComplete.text99452646e34b')}
                      />
                    </RadioGroup>
                  </DemoContainer>
                </div>

                <div id="comp-tabs" className="mb-12">
                  <ComponentLabel>
                    {tI18nHardcoded.raw('i18nComplete.text8e5ea509893e')}
                  </ComponentLabel>
                  <ComponentDesc>
                    {tHardcodedUi.raw(
                      'appHomeDesignSystemPage.line1395JsxTextTabbedNavigationWithStandardAndCompactVariants',
                    )}
                  </ComponentDesc>
                  <DemoContainer>
                    <div className="space-y-6">
                      <div>
                        <p className="text-muted-foreground mb-3 text-xs">
                          {tI18nHardcoded.raw('i18nComplete.textef6691545d2c')}
                        </p>
                        <Tabs defaultValue="tab1">
                          <TabsList>
                            <TabsTrigger value="tab1">
                              {tI18nHardcoded.raw('i18nComplete.text7e1b0d5641f2')}
                            </TabsTrigger>
                            <TabsTrigger value="tab2">
                              {tI18nHardcoded.raw('i18nComplete.texte7cf3ef4f17c')}
                            </TabsTrigger>
                            <TabsTrigger value="tab3">
                              {tI18nHardcoded.raw('i18nComplete.text74a883a037bc')}
                            </TabsTrigger>
                          </TabsList>
                          <TabsContent value="tab1">
                            <p className="text-muted-foreground mt-2 text-sm">
                              {tHardcodedUi.raw(
                                'appHomeDesignSystemPage.line1411JsxTextAccountSettingsAndPreferences',
                              )}
                            </p>
                          </TabsContent>
                          <TabsContent value="tab2">
                            <p className="text-muted-foreground mt-2 text-sm">
                              {tHardcodedUi.raw(
                                'appHomeDesignSystemPage.line1416JsxTextChangeYourPassword',
                              )}
                            </p>
                          </TabsContent>
                          <TabsContent value="tab3">
                            <p className="text-muted-foreground mt-2 text-sm">
                              {tHardcodedUi.raw(
                                'appHomeDesignSystemPage.line1421JsxTextGeneralSettings',
                              )}
                            </p>
                          </TabsContent>
                        </Tabs>
                      </div>
                      <div>
                        <p className="text-muted-foreground mb-3 text-xs">
                          {tI18nHardcoded.raw('i18nComplete.texteabbf3abaf8d')}
                        </p>
                        <Tabs defaultValue="outline-account">
                          <TabsList animate="none" className="bg-transparent p-0">
                            <TabsTrigger variant="outline" value="outline-account">
                              {tI18nHardcoded.raw('i18nComplete.text7e1b0d5641f2')}
                            </TabsTrigger>
                            <TabsTrigger variant="outline" value="outline-password">
                              {tI18nHardcoded.raw('i18nComplete.texte7cf3ef4f17c')}
                            </TabsTrigger>
                            <TabsTrigger variant="outline" value="outline-settings">
                              {tI18nHardcoded.raw('i18nComplete.text74a883a037bc')}
                            </TabsTrigger>
                          </TabsList>
                          <TabsContent value="outline-account">
                            <p className="text-muted-foreground mt-2 text-sm">
                              {tI18nHardcoded.raw('i18nComplete.text7e2d43454354')}
                            </p>
                          </TabsContent>
                          <TabsContent value="outline-password">
                            <p className="text-muted-foreground mt-2 text-sm">
                              {tI18nHardcoded.raw('i18nComplete.textdcd23310a7aa')}
                            </p>
                          </TabsContent>
                          <TabsContent value="outline-settings">
                            <p className="text-muted-foreground mt-2 text-sm">
                              {tI18nHardcoded.raw('i18nComplete.text54b316135c61')}
                            </p>
                          </TabsContent>
                        </Tabs>
                      </div>
                      <div>
                        <p className="text-muted-foreground mb-3 text-xs">
                          {tI18nHardcoded.raw('i18nComplete.text02f843261112')}
                        </p>
                        <Tabs defaultValue="underline-account">
                          <TabsList type="underline">
                            <TabsTrigger value="underline-account">
                              {tI18nHardcoded.raw('i18nComplete.text7e1b0d5641f2')}
                            </TabsTrigger>
                            <TabsTrigger value="underline-password">
                              {tI18nHardcoded.raw('i18nComplete.texte7cf3ef4f17c')}
                            </TabsTrigger>
                            <TabsTrigger value="underline-settings">
                              {tI18nHardcoded.raw('i18nComplete.text74a883a037bc')}
                            </TabsTrigger>
                          </TabsList>
                          <TabsContent value="underline-account">
                            <p className="text-muted-foreground mt-2 text-sm">
                              {tI18nHardcoded.raw('i18nComplete.text7e2d43454354')}
                            </p>
                          </TabsContent>
                          <TabsContent value="underline-password">
                            <p className="text-muted-foreground mt-2 text-sm">
                              {tI18nHardcoded.raw('i18nComplete.textdcd23310a7aa')}
                            </p>
                          </TabsContent>
                          <TabsContent value="underline-settings">
                            <p className="text-muted-foreground mt-2 text-sm">
                              {tI18nHardcoded.raw('i18nComplete.text54b316135c61')}
                            </p>
                          </TabsContent>
                        </Tabs>
                      </div>
                      <div>
                        <p className="text-muted-foreground mb-3 text-xs">
                          {tI18nHardcoded.raw('i18nComplete.textd71a0c697cce')}
                        </p>
                        <Tabs defaultValue="segmented-managed" className="max-w-sm">
                          <TabsList variant="segmented" className="w-full">
                            <TabsTrigger value="segmented-managed">
                              <CloudIcon />
                              {tI18nHardcoded.raw('i18nComplete.text9ae34cca7f2d')}
                            </TabsTrigger>
                            <TabsTrigger value="segmented-github">
                              <GithubLogoIcon />
                              GitHub
                            </TabsTrigger>
                          </TabsList>
                          <TabsContent value="segmented-managed">
                            <p className="text-muted-foreground mt-2 text-sm">
                              {tI18nHardcoded.raw('i18nComplete.textafecbae4466e')}
                            </p>
                          </TabsContent>
                          <TabsContent value="segmented-github">
                            <p className="text-muted-foreground mt-2 text-sm">
                              {tI18nHardcoded.raw('i18nComplete.text6cb9b40da8a0')}
                            </p>
                          </TabsContent>
                        </Tabs>
                      </div>
                      <div>
                        <p className="text-muted-foreground mb-3 text-xs">
                          {tI18nHardcoded.raw('i18nComplete.text99452646e34b')}
                        </p>
                        <Tabs defaultValue="c1">
                          <TabsListCompact>
                            <TabsTriggerCompact value="c1">
                              {tI18nHardcoded.raw('i18nComplete.text8f2364e11b8b')}
                            </TabsTriggerCompact>
                            <TabsTriggerCompact value="c2">
                              {tI18nHardcoded.raw('i18nComplete.texte78041ab51a8')}
                            </TabsTriggerCompact>
                            <TabsTriggerCompact value="c3">
                              {tI18nHardcoded.raw('i18nComplete.text310ca503ef36')}
                            </TabsTriggerCompact>
                          </TabsListCompact>
                          <TabsContent value="c1">
                            <p className="text-muted-foreground mt-2 text-sm">
                              {tHardcodedUi.raw(
                                'appHomeDesignSystemPage.line1444JsxTextDailyViewContent',
                              )}
                            </p>
                          </TabsContent>
                          <TabsContent value="c2">
                            <p className="text-muted-foreground mt-2 text-sm">
                              {tHardcodedUi.raw(
                                'appHomeDesignSystemPage.line1449JsxTextWeeklyViewContent',
                              )}
                            </p>
                          </TabsContent>
                          <TabsContent value="c3">
                            <p className="text-muted-foreground mt-2 text-sm">
                              {tHardcodedUi.raw(
                                'appHomeDesignSystemPage.line1454JsxTextMonthlyViewContent',
                              )}
                            </p>
                          </TabsContent>
                        </Tabs>
                      </div>
                    </div>
                  </DemoContainer>
                </div>

                <div id="comp-dialog" className="mb-12">
                  <ComponentLabel>
                    {tI18nHardcoded.raw('i18nComplete.text69b51517d04b')}
                  </ComponentLabel>
                  <ComponentDesc>
                    {tHardcodedUi.raw(
                      'appHomeDesignSystemPage.line1467JsxTextModalOverlayForFocusedInteractions',
                    )}
                  </ComponentDesc>
                  <DemoContainer>
                    <Dialog>
                      <DialogTrigger asChild>
                        <Button variant="outline">
                          {tHardcodedUi.raw('appHomeDesignSystemPage.line1472JsxTextOpenDialog')}
                        </Button>
                      </DialogTrigger>
                      <DialogContent>
                        <DialogHeader>
                          <DialogTitle>
                            {tHardcodedUi.raw('appHomeDesignSystemPage.line1476JsxTextDialogTitle')}
                          </DialogTitle>
                          <DialogDescription>
                            {tHardcodedUi.raw(
                              'appHomeDesignSystemPage.line1478JsxTextThisIsADescriptionOfTheDialogContent',
                            )}
                          </DialogDescription>
                        </DialogHeader>
                        <div className="py-4">
                          <p className="text-muted-foreground text-sm">
                            {tHardcodedUi.raw(
                              'appHomeDesignSystemPage.line1484JsxTextDialogBodyContentGoesHere',
                            )}
                          </p>
                        </div>
                        <DialogFooter>
                          <Button variant="outline">
                            {tI18nHardcoded.raw('i18nComplete.text19766ed6ccb2')}
                          </Button>
                          <Button>{tI18nHardcoded.raw('i18nComplete.texteebdd24a77d9')}</Button>
                        </DialogFooter>
                      </DialogContent>
                    </Dialog>
                  </DemoContainer>
                </div>

                <div id="comp-modal" className="mb-12">
                  <ComponentLabel>
                    {tI18nHardcoded.raw('i18nComplete.text18093cad2644')}
                  </ComponentLabel>
                  <ComponentDesc>
                    {tI18nHardcoded.raw(
                      'autoAppPublicMarketingDesignSystemPageJsxTextResponsiveOverlay8094b284',
                    )}
                    <code className="font-mono text-xs">side</code>.
                  </ComponentDesc>
                  <DemoContainer>
                    <Modal>
                      <ModalTrigger asChild>
                        <Button variant="outline">
                          {tI18nHardcoded.raw(
                            'autoAppPublicMarketingDesignSystemPageJsxTextOpenModal87b8fff8',
                          )}
                        </Button>
                      </ModalTrigger>
                      <ModalContent>
                        <ModalHeader>
                          <ModalTitle>
                            {tI18nHardcoded.raw(
                              'autoAppPublicMarketingDesignSystemPageJsxTextModalTitle4b2e4477',
                            )}
                          </ModalTitle>
                          <ModalDescription>
                            {tI18nHardcoded.raw(
                              'autoAppPublicMarketingDesignSystemPageJsxTextThisIs8e3df96c',
                            )}
                          </ModalDescription>
                        </ModalHeader>
                        <ModalBody>
                          <p className="text-muted-foreground text-sm">
                            {tI18nHardcoded.raw(
                              'autoAppPublicMarketingDesignSystemPageJsxTextModalBody7732d54c',
                            )}
                          </p>
                        </ModalBody>
                        <ModalFooter>
                          <Button variant="outline">
                            {tI18nHardcoded.raw('i18nComplete.text19766ed6ccb2')}
                          </Button>
                          <Button>{tI18nHardcoded.raw('i18nComplete.texteebdd24a77d9')}</Button>
                        </ModalFooter>
                      </ModalContent>
                    </Modal>
                  </DemoContainer>
                </div>

                <div id="comp-sheet" className="mb-12">
                  <ComponentLabel>
                    {tI18nHardcoded.raw('i18nComplete.text54bf0ebbfb3e')}
                  </ComponentLabel>
                  <ComponentDesc>
                    {tHardcodedUi.raw(
                      'appHomeDesignSystemPage.line1500JsxTextSlideOutPanelFromTheEdgeOfThe',
                    )}
                  </ComponentDesc>
                  <DemoContainer>
                    <Sheet>
                      <SheetTrigger asChild>
                        <Button variant="outline">
                          {tHardcodedUi.raw('appHomeDesignSystemPage.line1505JsxTextOpenSheet')}
                        </Button>
                      </SheetTrigger>
                      <SheetContent>
                        <SheetHeader>
                          <SheetTitle>
                            {tHardcodedUi.raw('appHomeDesignSystemPage.line1509JsxTextSheetTitle')}
                          </SheetTitle>
                          <SheetDescription>
                            {tHardcodedUi.raw(
                              'appHomeDesignSystemPage.line1511JsxTextASidePanelForSecondaryContentAndActions',
                            )}
                          </SheetDescription>
                        </SheetHeader>
                        <div className="py-6">
                          <p className="text-muted-foreground text-sm">
                            {tHardcodedUi.raw(
                              'appHomeDesignSystemPage.line1516JsxTextSheetBodyContent',
                            )}
                          </p>
                        </div>
                      </SheetContent>
                    </Sheet>
                  </DemoContainer>
                </div>

                <div id="comp-tooltip" className="mb-12">
                  <ComponentLabel>
                    {tI18nHardcoded.raw('i18nComplete.text20f12289f9b8')}
                  </ComponentLabel>
                  <ComponentDesc>
                    {tHardcodedUi.raw(
                      'appHomeDesignSystemPage.line1558JsxTextContextualInformationOnHover',
                    )}
                  </ComponentDesc>
                  <DemoContainer>
                    <div className="flex flex-wrap gap-3">
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button variant="outline" size="icon">
                              <HelpCircle className="size-4" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>
                            <p>
                              {tHardcodedUi.raw(
                                'appHomeDesignSystemPage.line1570JsxTextThisIsAHelpfulTooltip',
                              )}
                            </p>
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button variant="outline" size="icon">
                              <Settings className="size-4" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>
                            <p>{tI18nHardcoded.raw('i18nComplete.text74a883a037bc')}</p>
                            <KbdGroup>
                              <Kbd>⌘</Kbd>
                              <Kbd>,</Kbd>
                            </KbdGroup>
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    </div>
                  </DemoContainer>
                </div>

                <div id="comp-popover" className="mb-12">
                  <ComponentLabel>
                    {tI18nHardcoded.raw('i18nComplete.text064f6ac1a789')}
                  </ComponentLabel>
                  <ComponentDesc>
                    {tHardcodedUi.raw(
                      'appHomeDesignSystemPage.line1598JsxTextFloatingContentPanelAttachedToATrigger',
                    )}
                  </ComponentDesc>
                  <DemoContainer>
                    <Popover>
                      <PopoverTrigger asChild>
                        <Button variant="outline">
                          {tHardcodedUi.raw('appHomeDesignSystemPage.line1603JsxTextOpenPopover')}
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent className="w-64">
                        <div className="space-y-2">
                          <p className="text-sm font-medium">
                            {tHardcodedUi.raw(
                              'appHomeDesignSystemPage.line1607JsxTextPopoverTitle',
                            )}
                          </p>
                          <p className="text-muted-foreground text-xs">
                            {tHardcodedUi.raw(
                              'appHomeDesignSystemPage.line1609JsxTextThisIsThePopoverContentItCanContain',
                            )}
                          </p>
                        </div>
                      </PopoverContent>
                    </Popover>
                  </DemoContainer>
                </div>

                <div id="comp-emoji-picker" className="mb-12">
                  <ComponentLabel>
                    {tI18nHardcoded.raw('i18nComplete.text7a9d22da3496')}
                  </ComponentLabel>
                  <ComponentDesc>
                    {tI18nHardcoded.raw('i18nComplete.textdc4156c43e06')}
                    <code>public/emojibase/</code>{' '}
                    {tI18nHardcoded.raw('i18nComplete.text639c4f3db6ec')}
                  </ComponentDesc>
                  <DemoContainer>
                    <EmojiPickerDemo />
                  </DemoContainer>
                </div>

                <div id="comp-project-icon-picker" className="mb-12">
                  <ComponentLabel>
                    {tI18nHardcoded.raw('i18nComplete.text44088993f639')}
                  </ComponentLabel>
                  <ComponentDesc>
                    {tI18nHardcoded.raw('i18nComplete.text8d199c5ef725')} <code>Tabs</code>{' '}
                    {tI18nHardcoded.raw('i18nComplete.text7e27fa80abb2')}
                    <code>368px</code> {tI18nHardcoded.raw('i18nComplete.text2b4d98953dc8')}
                  </ComponentDesc>
                  <DemoContainer>
                    <ProjectIconPickerDemo />
                  </DemoContainer>
                </div>

                <div id="comp-alert" className="mb-12">
                  <ComponentLabel>
                    {tI18nHardcoded.raw('i18nComplete.text44a57b22e03d')}
                  </ComponentLabel>
                  <ComponentDesc>
                    {tHardcodedUi.raw(
                      'appHomeDesignSystemPage.line1622JsxTextInlineNotificationWithContextualVariants',
                    )}
                  </ComponentDesc>
                  <DemoContainer>
                    <div className="space-y-3">
                      <Alert>
                        <AlertMedia>
                          <Info className="size-4" />
                        </AlertMedia>
                        <AlertContent>
                          <AlertTitle>
                            {tHardcodedUi.raw(
                              'appHomeDesignSystemPage.line1628JsxTextDefaultAlert',
                            )}
                          </AlertTitle>
                          <AlertDescription>
                            {tHardcodedUi.raw(
                              'appHomeDesignSystemPage.line1630JsxTextThisIsADefaultInformationalAlert',
                            )}
                          </AlertDescription>
                        </AlertContent>
                      </Alert>
                      <Alert variant="destructive">
                        <AlertMedia>
                          <AlertCircle className="size-4" />
                        </AlertMedia>
                        <AlertContent>
                          <AlertTitle>
                            {tI18nHardcoded.raw('i18nComplete.textc3e58a73609d')}
                          </AlertTitle>
                          <AlertDescription>
                            {tHardcodedUi.raw(
                              'appHomeDesignSystemPage.line1637JsxTextSomethingWentWrongPleaseTryAgain',
                            )}
                          </AlertDescription>
                        </AlertContent>
                      </Alert>
                      <Alert variant="warning">
                        <AlertMedia>
                          <TriangleAlert className="size-4" />
                        </AlertMedia>
                        <AlertContent>
                          <AlertTitle>
                            {tI18nHardcoded.raw('i18nComplete.texte981ddae45d8')}
                          </AlertTitle>
                          <AlertDescription>
                            {tHardcodedUi.raw(
                              'appHomeDesignSystemPage.line1644JsxTextThisActionMayHaveUnintendedConsequences',
                            )}
                          </AlertDescription>
                        </AlertContent>
                      </Alert>
                    </div>
                  </DemoContainer>
                </div>

                <div id="comp-toast" className="mb-12">
                  <ComponentLabel>
                    {tI18nHardcoded.raw('i18nComplete.text34b86033459d')}
                  </ComponentLabel>
                  <ComponentDesc>
                    {tI18nHardcoded.raw(
                      'autoAppPublicMarketingDesignSystemPageJsxTextEphemeralNotifications64698ef7',
                    )}{' '}
                    <code>successToast</code>, <code>errorToast</code>, <code>infoToast</code>,{' '}
                    <code>warningToast</code>
                    {tI18nHardcoded.raw('autoAppPublicMarketingDesignSystemPageJsxTextAndd93e251a')}
                    <code>loadingToast</code> {tI18nHardcoded.raw('i18nComplete.text75857a458999')}{' '}
                    <code>
                      {tI18nHardcoded.raw(
                        'autoAppPublicMarketingDesignSystemPageJsxTextComponentsUi3eb49cdd',
                      )}
                    </code>{' '}
                    {tI18nHardcoded.raw(
                      'autoAppPublicMarketingDesignSystemPageJsxTextNotRaw7f6d0bf8',
                    )}
                  </ComponentDesc>
                  <DemoContainer>
                    <div className="space-y-6">
                      <div>
                        <p className="text-muted-foreground mb-3 text-xs tracking-wider uppercase">
                          {tI18nHardcoded.raw('i18nComplete.text63d2643b059e')}
                        </p>
                        <div className="flex flex-wrap gap-2">
                          <Button
                            onClick={() =>
                              successToast(tI18nHardcoded.raw('i18nComplete.textb5c120b316c2'), {
                                description: tI18nHardcoded.raw('i18nComplete.texta96b9d862cf9'),
                              })
                            }
                            variant="success"
                          >
                            {tI18nHardcoded.raw('i18nComplete.textc88a0b907419')}
                          </Button>
                          <Button
                            onClick={() =>
                              errorToast(tI18nHardcoded.raw('i18nComplete.text12467751a925'), {
                                description: tI18nHardcoded.raw('i18nComplete.text69fe3e7c4d5a'),
                              })
                            }
                            variant="error"
                          >
                            {tI18nHardcoded.raw('i18nComplete.text54a0e8c17ebb')}
                          </Button>
                          <Button
                            onClick={() =>
                              infoToast(tI18nHardcoded.raw('i18nComplete.textf9b19898161f'), {
                                description: tI18nHardcoded.raw('i18nComplete.text5a4db0bfccdc'),
                              })
                            }
                            variant="info"
                          >
                            {tI18nHardcoded.raw('i18nComplete.text170322a32f3c')}
                          </Button>
                          <Button
                            onClick={() =>
                              warningToast(tI18nHardcoded.raw('i18nComplete.textf7243551e2b7'), {
                                description: tI18nHardcoded.raw('i18nComplete.text558bb9bf0163'),
                              })
                            }
                            variant="warning"
                          >
                            {tI18nHardcoded.raw('i18nComplete.texte981ddae45d8')}
                          </Button>
                        </div>
                      </div>
                      <div>
                        <p className="text-muted-foreground mb-3 text-xs tracking-wider uppercase">
                          {tI18nHardcoded.raw('i18nComplete.text1eec97a07f6b')}
                        </p>
                        <div className="flex flex-wrap gap-2">
                          <Button
                            variant="secondary"
                            onClick={() =>
                              loadingToast(
                                tI18nHardcoded.raw('i18nComplete.text96e743d6c46e'),
                                () =>
                                  new Promise<string>((resolve) => {
                                    setTimeout(() => resolve('Saved'), 2000);
                                  }),
                                {
                                  description: tI18nHardcoded.raw('i18nComplete.text5c991b7cc507'),
                                  success: (data) => data,
                                },
                              )
                            }
                          >
                            {tI18nHardcoded.raw(
                              'autoAppPublicMarketingDesignSystemPageJsxTextLoadingSuccessde0ea42f',
                            )}
                          </Button>
                          <Button
                            variant="secondary"
                            onClick={() =>
                              loadingToast(
                                tI18nHardcoded.raw('i18nComplete.text96e743d6c46e'),
                                () =>
                                  new Promise<never>((_resolve, reject) => {
                                    setTimeout(
                                      () =>
                                        reject(
                                          new Error(
                                            tI18nHardcoded.raw('i18nComplete.text2a33d984de88'),
                                          ),
                                        ),
                                      2000,
                                    );
                                  }),
                                {
                                  description: tI18nHardcoded.raw('i18nComplete.texta2daa4911a3f'),
                                  showErrorToast: true,
                                },
                              ).catch(() => undefined)
                            }
                          >
                            {tI18nHardcoded.raw(
                              'autoAppPublicMarketingDesignSystemPageJsxTextLoadingErrorda06eee7',
                            )}
                          </Button>
                        </div>
                      </div>
                    </div>
                  </DemoContainer>
                </div>

                <div id="comp-alert-dialog" className="mb-12">
                  <ComponentLabel>
                    {tHardcodedUi.raw('appHomeDesignSystemPage.line1653JsxTextAlertDialog')}
                  </ComponentLabel>
                  <ComponentDesc>
                    {tHardcodedUi.raw(
                      'appHomeDesignSystemPage.line1655JsxTextConfirmationDialogForDestructiveOrImportantActions',
                    )}
                  </ComponentDesc>
                  <DemoContainer>
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button variant="destructive">
                          {tHardcodedUi.raw('appHomeDesignSystemPage.line1660JsxTextDeleteItem')}
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>
                            {tHardcodedUi.raw('appHomeDesignSystemPage.line1665JsxTextAreYouSure')}
                          </AlertDialogTitle>
                          <AlertDialogDescription>
                            {tHardcodedUi.raw(
                              'appHomeDesignSystemPage.line1668JsxTextThisActionCannotBeUndoneThisWillPermanently',
                            )}
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>
                            {tI18nHardcoded.raw('i18nComplete.text19766ed6ccb2')}
                          </AlertDialogCancel>
                          <AlertDialogAction>
                            {tI18nHardcoded.raw('i18nComplete.texte2d0a54968ea')}
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </DemoContainer>
                </div>

                <div id="comp-accordion" className="mb-12">
                  <ComponentLabel>
                    {tI18nHardcoded.raw('i18nComplete.text68344d566701')}
                  </ComponentLabel>
                  <ComponentDesc>
                    {tHardcodedUi.raw(
                      'appHomeDesignSystemPage.line1685JsxTextCollapsibleContentSectionsWithSmoothAnimation',
                    )}
                  </ComponentDesc>
                  <DemoContainer>
                    <Accordion type="single" collapsible className="w-full">
                      <AccordionItem value="item-1">
                        <AccordionTrigger>
                          {tHardcodedUi.raw('appHomeDesignSystemPage.line1691JsxTextWhatIsKortix')}
                        </AccordionTrigger>
                        <AccordionContent>
                          {tHardcodedUi.raw(
                            'appHomeDesignSystemPage.line1694JsxTextKortixIsAnAiPoweredPlatformForBuilding',
                          )}
                        </AccordionContent>
                      </AccordionItem>
                      <AccordionItem value="item-2">
                        <AccordionTrigger>
                          {tHardcodedUi.raw(
                            'appHomeDesignSystemPage.line1702JsxTextWhatDesignSystemDoesItUse',
                          )}
                        </AccordionTrigger>
                        <AccordionContent>
                          {tHardcodedUi.raw(
                            'appHomeDesignSystemPage.line1705JsxTextKortixUsesAMonochromaticDesignSystemWithStrategic',
                          )}
                        </AccordionContent>
                      </AccordionItem>
                      <AccordionItem value="item-3">
                        <AccordionTrigger>
                          {tHardcodedUi.raw(
                            'appHomeDesignSystemPage.line1712JsxTextHowDoThemesWork',
                          )}
                        </AccordionTrigger>
                        <AccordionContent>
                          {tHardcodedUi.raw(
                            'appHomeDesignSystemPage.line1715JsxTextEachThemeDefinesASingleAccentHueApplied',
                          )}
                        </AccordionContent>
                      </AccordionItem>
                    </Accordion>
                  </DemoContainer>
                </div>

                <div id="comp-collapsible" className="mb-12">
                  <ComponentLabel>
                    {tI18nHardcoded.raw('i18nComplete.textd4a5d5f8fd9b')}
                  </ComponentLabel>
                  <ComponentDesc>
                    {tHardcodedUi.raw(
                      'appHomeDesignSystemPage.line1730JsxTextASimplerExpandCollapsePrimitiveUnlikeAccordionIt',
                    )}
                  </ComponentDesc>
                  <DemoContainer>
                    <Collapsible
                      open={collapsibleOpen}
                      onOpenChange={setCollapsibleOpen}
                      className="w-full"
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-medium">
                          {tHardcodedUi.raw(
                            'appHomeDesignSystemPage.line1741JsxTextText3TaggedItems',
                          )}
                        </span>
                        <CollapsibleTrigger asChild>
                          <Button variant="ghost" size="sm">
                            <ChevronsUpDown className="size-4" />
                            <span className="sr-only">
                              {tI18nHardcoded.raw('i18nComplete.text3d03a1dea561')}
                            </span>
                          </Button>
                        </CollapsibleTrigger>
                      </div>
                      <div className="border-border/50 mt-2 rounded-md border px-4 py-2 text-sm">
                        {tHardcodedUi.raw(
                          'appHomeDesignSystemPage.line1751JsxTextKortixDesignSystem',
                        )}
                      </div>
                      <CollapsibleContent className="mt-2 space-y-2">
                        <div className="border-border/50 rounded-md border px-4 py-2 text-sm">
                          {tHardcodedUi.raw(
                            'appHomeDesignSystemPage.line1755JsxTextKortixComponents',
                          )}
                        </div>
                        <div className="border-border/50 rounded-md border px-4 py-2 text-sm">
                          {tHardcodedUi.raw('appHomeDesignSystemPage.line1758JsxTextKortixTokens')}
                        </div>
                      </CollapsibleContent>
                    </Collapsible>
                  </DemoContainer>
                </div>

                <div id="comp-separator" className="mb-12">
                  <ComponentLabel>
                    {tI18nHardcoded.raw('i18nComplete.textbe237eda7fff')}
                  </ComponentLabel>
                  <ComponentDesc>
                    {tHardcodedUi.raw(
                      'appHomeDesignSystemPage.line1769JsxTextVisualDividerBetweenContentSections',
                    )}
                  </ComponentDesc>
                  <DemoContainer>
                    <div className="space-y-4">
                      <p className="text-muted-foreground text-sm">
                        {tHardcodedUi.raw('appHomeDesignSystemPage.line1774JsxTextContentAbove')}
                      </p>
                      <Separator />
                      <p className="text-muted-foreground text-sm">
                        {tHardcodedUi.raw('appHomeDesignSystemPage.line1778JsxTextContentBelow')}
                      </p>
                    </div>
                  </DemoContainer>
                </div>

                <div id="comp-skeleton" className="mb-12">
                  <ComponentLabel>
                    {tI18nHardcoded.raw('i18nComplete.textea5f6bdc79b8')}
                  </ComponentLabel>
                  <ComponentDesc>
                    {tHardcodedUi.raw(
                      'appHomeDesignSystemPage.line1788JsxTextLoadingPlaceholderForContentThatHasn',
                    )}
                    {"'"}
                    {tHardcodedUi.raw('appHomeDesignSystemPage.line1788JsxTextTLoadedYet')}
                  </ComponentDesc>
                  <DemoContainer>
                    <div className="space-y-6">
                      {/* Card-like skeleton */}
                      <div>
                        <p className="text-muted-foreground mb-3 text-xs">
                          {tHardcodedUi.raw('appHomeDesignSystemPage.line1795JsxTextCardSkeleton')}
                        </p>
                        <div className="flex items-start gap-4">
                          <Skeleton className="size-12 rounded-full" />
                          <div className="flex-1 space-y-2">
                            <Skeleton className="h-4 w-48" />
                            <Skeleton className="h-4 w-full" />
                            <Skeleton className="h-4 w-3/4" />
                          </div>
                        </div>
                      </div>
                      {/* Inline skeletons */}
                      <div>
                        <p className="text-muted-foreground mb-3 text-xs">
                          {tHardcodedUi.raw(
                            'appHomeDesignSystemPage.line1809JsxTextInlineVariants',
                          )}
                        </p>
                        <div className="space-y-3">
                          <Skeleton className="h-10 w-full rounded-2xl" />
                          <div className="flex gap-3">
                            <Skeleton className="h-8 w-24 rounded-xl" />
                            <Skeleton className="h-8 w-32 rounded-xl" />
                            <Skeleton className="h-8 w-20 rounded-xl" />
                          </div>
                        </div>
                      </div>
                    </div>
                  </DemoContainer>
                </div>

                <div id="comp-progress" className="mb-12">
                  <ComponentLabel>
                    {tI18nHardcoded.raw('i18nComplete.text4664827f8e89')}
                  </ComponentLabel>
                  <ComponentDesc>
                    {tHardcodedUi.raw(
                      'appHomeDesignSystemPage.line1828JsxTextVisualIndicatorOfCompletionOrLoading',
                    )}
                  </ComponentDesc>
                  <DemoContainer>
                    <div className="space-y-4">
                      {[0, 25, 50, 75, 100].map((v) => (
                        <div key={v} className="space-y-1.5">
                          <span className="text-muted-foreground font-mono text-xs">{v}%</span>
                          <Progress value={v} />
                        </div>
                      ))}
                    </div>
                  </DemoContainer>
                </div>

                <div id="comp-slider" className="mb-12">
                  <ComponentLabel>
                    {tI18nHardcoded.raw('i18nComplete.text14f34284b054')}
                  </ComponentLabel>
                  <ComponentDesc>
                    {tHardcodedUi.raw(
                      'appHomeDesignSystemPage.line1848JsxTextRangeInputForSelectingNumericValues',
                    )}
                  </ComponentDesc>
                  <DemoContainer>
                    <div className="max-w-sm space-y-4">
                      <Slider
                        value={sliderValue}
                        onValueChange={setSliderValue}
                        max={100}
                        step={1}
                      />
                      <span className="text-muted-foreground font-mono text-xs">
                        {tI18nHardcoded.raw('i18nComplete.text224a3369a5c9')} {sliderValue[0]}
                      </span>
                    </div>
                  </DemoContainer>
                </div>

                <div id="comp-label" className="mb-12">
                  <ComponentLabel>
                    {tI18nHardcoded.raw('i18nComplete.text0e66373f45dc')}
                  </ComponentLabel>
                  <ComponentDesc>
                    {tHardcodedUi.raw(
                      'appHomeDesignSystemPage.line1869JsxTextAccessibleLabelForFormControls',
                    )}
                  </ComponentDesc>
                  <DemoContainer>
                    <div className="max-w-sm space-y-2">
                      <Label htmlFor="label-demo">
                        {tHardcodedUi.raw('appHomeDesignSystemPage.line1873JsxTextEmailAddress')}
                      </Label>
                      <Input
                        id="label-demo"
                        type="email"
                        placeholder={tHardcodedUi.raw(
                          'appHomeDesignSystemPage.line1877JsxAttrPlaceholderYouExampleCom',
                        )}
                      />
                    </div>
                  </DemoContainer>
                </div>

                <div id="comp-kbd" className="mb-12">
                  <ComponentLabel>
                    {tI18nHardcoded.raw('i18nComplete.text76cce341b6b9')}
                  </ComponentLabel>
                  <ComponentDesc>
                    {tHardcodedUi.raw(
                      'appHomeDesignSystemPage.line1968JsxTextKeyboardShortcutIndicatorsThemeAwareIncludingAutomaticStyling',
                    )}
                  </ComponentDesc>
                  <DemoContainer>
                    <div className="space-y-4">
                      <div>
                        <p className="text-muted-foreground mb-3 text-xs">
                          {tHardcodedUi.raw(
                            'appHomeDesignSystemPage.line1975JsxTextIndividualKeys',
                          )}
                        </p>
                        <div className="flex flex-wrap items-center gap-2">
                          <Kbd>⌘</Kbd>
                          <Kbd>K</Kbd>
                          <Kbd>{tI18nHardcoded.raw('i18nComplete.text2e544a292f69')}</Kbd>
                          <Kbd>{tI18nHardcoded.raw('i18nComplete.textdc8659db6d41')}</Kbd>
                          <Kbd>{tI18nHardcoded.raw('i18nComplete.text52f878edb34f')}</Kbd>
                          <Kbd>{tI18nHardcoded.raw('i18nComplete.text90ddf1963abb')}</Kbd>
                        </div>
                      </div>
                      <div>
                        <p className="text-muted-foreground mb-3 text-xs">
                          {tHardcodedUi.raw(
                            'appHomeDesignSystemPage.line1988JsxTextKeyGroupsShortcuts',
                          )}
                        </p>
                        <div className="flex flex-wrap items-center gap-4">
                          <KbdGroup>
                            <Kbd>⌘</Kbd>
                            <span className="text-muted-foreground text-xs">+</span>
                            <Kbd>K</Kbd>
                          </KbdGroup>
                          <KbdGroup>
                            <Kbd>⌘</Kbd>
                            <span className="text-muted-foreground text-xs">+</span>
                            <Kbd>{tI18nHardcoded.raw('i18nComplete.text2e544a292f69')}</Kbd>
                            <span className="text-muted-foreground text-xs">+</span>
                            <Kbd>P</Kbd>
                          </KbdGroup>
                          <KbdGroup>
                            <Kbd>{tI18nHardcoded.raw('i18nComplete.texte2ee2909fe27')}</Kbd>
                            <span className="text-muted-foreground text-xs">+</span>
                            <Kbd>C</Kbd>
                          </KbdGroup>
                        </div>
                      </div>
                      <div>
                        <p className="text-muted-foreground mb-3 text-xs tracking-wider uppercase">
                          {tI18nHardcoded.raw(
                            'autoAppPublicMarketingDesignSystemPageJsxTextInTooltips3dc63b0c',
                          )}
                        </p>
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button variant="outline">
                                {tI18nHardcoded.raw(
                                  'autoAppPublicMarketingDesignSystemPageJsxTextCommandPalettea9dabb80',
                                )}
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>
                              <p>{tI18nHardcoded.raw('i18nComplete.text49c266baaaa7')}</p>
                              <KbdGroup>
                                <Kbd>⌘</Kbd>
                                <Kbd>K</Kbd>
                              </KbdGroup>
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      </div>
                    </div>
                  </DemoContainer>
                </div>

                <div id="comp-breadcrumb" className="mb-12">
                  <ComponentLabel>
                    {tI18nHardcoded.raw('i18nComplete.text2bd873d6c734')}
                  </ComponentLabel>
                  <ComponentDesc>
                    {tHardcodedUi.raw(
                      'appHomeDesignSystemPage.line1887JsxTextNavigationHierarchyTrail',
                    )}
                  </ComponentDesc>
                  <DemoContainer>
                    <Breadcrumb>
                      <BreadcrumbList>
                        <BreadcrumbItem>
                          <BreadcrumbLink href="#">
                            {tI18nHardcoded.raw('i18nComplete.text3a78695388b3')}
                          </BreadcrumbLink>
                        </BreadcrumbItem>
                        <BreadcrumbSeparator />
                        <BreadcrumbItem>
                          <BreadcrumbLink href="#">
                            {tI18nHardcoded.raw('i18nComplete.text87bb59ba2f92')}
                          </BreadcrumbLink>
                        </BreadcrumbItem>
                        <BreadcrumbSeparator />
                        <BreadcrumbItem>
                          <BreadcrumbPage>
                            {tHardcodedUi.raw(
                              'appHomeDesignSystemPage.line1901JsxTextDesignSystem',
                            )}
                          </BreadcrumbPage>
                        </BreadcrumbItem>
                      </BreadcrumbList>
                    </Breadcrumb>
                  </DemoContainer>
                </div>

                <div id="comp-table" className="mb-12">
                  <ComponentLabel>
                    {tI18nHardcoded.raw('i18nComplete.text16d1c9050a0b')}
                  </ComponentLabel>
                  <ComponentDesc>
                    {tHardcodedUi.raw(
                      'appHomeDesignSystemPage.line1912JsxTextStructuredDataDisplayInRowsAndColumns',
                    )}
                  </ComponentDesc>
                  <DemoContainer className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>
                            {tI18nHardcoded.raw('i18nComplete.textce54f0e22dbb')}
                          </TableHead>
                          <TableHead>
                            {tI18nHardcoded.raw('i18nComplete.text63d2643b059e')}
                          </TableHead>
                          <TableHead>
                            {tI18nHardcoded.raw('i18nComplete.text920e413c7d41')}
                          </TableHead>
                          <TableHead className="text-right">
                            {tI18nHardcoded.raw('i18nComplete.textaa8c181ac338')}
                          </TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        <TableRow>
                          <TableCell className="font-medium">
                            {tI18nHardcoded.raw('i18nComplete.text707eab0c23ec')}
                          </TableCell>
                          <TableCell>6</TableCell>
                          <TableCell>
                            <Badge variant="new" className="text-xs">
                              {tI18nHardcoded.raw('i18nComplete.text90ee305714d7')}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-right">624</TableCell>
                        </TableRow>
                        <TableRow>
                          <TableCell className="font-medium">
                            {tI18nHardcoded.raw('i18nComplete.text002474e36821')}
                          </TableCell>
                          <TableCell>7</TableCell>
                          <TableCell>
                            <Badge variant="new" className="text-xs">
                              {tI18nHardcoded.raw('i18nComplete.text90ee305714d7')}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-right">189</TableCell>
                        </TableRow>
                        <TableRow>
                          <TableCell className="font-medium">
                            {tI18nHardcoded.raw('i18nComplete.textbe3702e3f1af')}
                          </TableCell>
                          <TableCell>2</TableCell>
                          <TableCell>
                            <Badge variant="new" className="text-xs">
                              {tI18nHardcoded.raw('i18nComplete.text90ee305714d7')}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-right">312</TableCell>
                        </TableRow>
                        <TableRow>
                          <TableCell className="font-medium">
                            {tI18nHardcoded.raw('i18nComplete.text36ecb4f86691')}
                          </TableCell>
                          <TableCell>1</TableCell>
                          <TableCell>
                            <Badge variant="beta" className="text-xs">
                              {tI18nHardcoded.raw('i18nComplete.text6c5b75e51441')}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-right">247</TableCell>
                        </TableRow>
                      </TableBody>
                    </Table>
                  </DemoContainer>
                </div>

                <div id="comp-calendar" className="mb-12">
                  <ComponentLabel>
                    {tI18nHardcoded.raw('i18nComplete.textd5d0a30b517e')}
                  </ComponentLabel>
                  <ComponentDesc>
                    {tHardcodedUi.raw(
                      'appHomeDesignSystemPage.line2026JsxTextDatePickerCalendarGrid',
                    )}
                  </ComponentDesc>
                  <DemoContainer>
                    <Calendar
                      mode="single"
                      selected={selectedDate}
                      onSelect={setSelectedDate}
                      className="border-border/50 rounded-lg border"
                    />
                  </DemoContainer>
                </div>

                <div id="comp-scrollarea" className="mb-12">
                  <ComponentLabel>
                    {tHardcodedUi.raw('appHomeDesignSystemPage.line2040JsxTextScrollArea')}
                  </ComponentLabel>
                  <ComponentDesc>
                    {tHardcodedUi.raw(
                      'appHomeDesignSystemPage.line2042JsxTextCustomScrollableContainerWithStyledScrollbar',
                    )}
                  </ComponentDesc>
                  <DemoContainer>
                    <ScrollArea className="border-border/50 h-48 w-full rounded-md border p-4">
                      <div className="space-y-2">
                        {Array.from({ length: 20 }, (_, i) => (
                          <div
                            key={i}
                            className="border-border/20 flex items-center gap-3 border-b py-1.5"
                          >
                            <span className="text-muted-foreground w-6 font-mono text-xs">
                              {String(i + 1).padStart(2, '0')}
                            </span>
                            <span className="text-foreground text-sm">
                              {tHardcodedUi.raw('appHomeDesignSystemPage.line2056JsxTextListItem')}
                              {i + 1}
                            </span>
                          </div>
                        ))}
                      </div>
                    </ScrollArea>
                  </DemoContainer>
                </div>
              </CollapsibleSection>

              <CollapsibleSection
                id="page-patterns"
                label={tHardcodedUi.raw('appHomeDesignSystemPage.line2070JsxTextPagePatterns')}
                summary={tI18nHardcoded.raw('i18nComplete.text65562e698ff8')}
              >
                <p className="text-muted-foreground mb-8 text-base leading-relaxed">
                  {tHardcodedUi.raw(
                    'appHomeDesignSystemPage.line2073JsxTextHowKortixListManagementPagesAreBuiltThese',
                  )}
                  <code className="font-mono text-xs">/scheduled-tasks</code>,{' '}
                  <code className="font-mono text-xs">/tunnel</code>
                  {tHardcodedUi.raw(
                    'appHomeDesignSystemPage.line2075JsxTextNewManagementStylePagesShouldComposeTheSame',
                  )}
                </p>

                {/* ── SpotlightCard ── */}
                <div id="pat-spotlight-card" className="mb-12">
                  <ComponentLabel>
                    {tI18nHardcoded.raw('i18nComplete.text4bbe0b7e8387')}
                  </ComponentLabel>
                  <ComponentDesc>
                    {tHardcodedUi.raw(
                      'appHomeDesignSystemPage.line2113JsxTextItemCardUsedAcrossEveryListPageMouse',
                    )}
                    <code className="font-mono text-xs">
                      {tHardcodedUi.raw(
                        'appHomeDesignSystemPage.line2115JsxTextBgCardBorderBorderBorder50',
                      )}
                    </code>
                    {tHardcodedUi.raw(
                      'appHomeDesignSystemPage.line2115JsxTextAndApplyYourOwnInnerPadding',
                    )}
                  </ComponentDesc>
                  <DemoContainer>
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                      {[
                        {
                          icon: Cable,
                          label: tI18nHardcoded.raw('i18nComplete.text5b4cd52a0cf7'),
                          sub: tI18nHardcoded.raw('i18nComplete.text76eaadc67d03'),
                        },
                        {
                          icon: Radio,
                          label: tI18nHardcoded.raw('i18nComplete.texta57d47538d79'),
                          sub: tI18nHardcoded.raw('i18nComplete.textda7d161a2777'),
                        },
                        {
                          icon: Zap,
                          label: tI18nHardcoded.raw('i18nComplete.text43f94e8f3c65'),
                          sub: tI18nHardcoded.raw('i18nComplete.textb8babd5bba24'),
                        },
                        {
                          icon: Plug,
                          label: tI18nHardcoded.raw('i18nComplete.textf911e414cf6b'),
                          sub: tI18nHardcoded.raw('i18nComplete.text22965568d22a'),
                        },
                      ].map((item) => {
                        const I = item.icon;
                        return (
                          <SpotlightCard
                            key={item.label}
                            className="bg-card border-border/50 border"
                          >
                            <div className="flex cursor-pointer items-center gap-3 p-4">
                              <div className="bg-muted border-border/50 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border">
                                <I className="text-foreground h-4 w-4" />
                              </div>
                              <div className="min-w-0 flex-1">
                                <div className="text-foreground truncate text-sm font-semibold">
                                  {item.label}
                                </div>
                                <div className="text-muted-foreground truncate text-xs">
                                  {item.sub}
                                </div>
                              </div>
                            </div>
                          </SpotlightCard>
                        );
                      })}
                    </div>
                  </DemoContainer>
                </div>

                {/* ── PageSearchBar ── */}
                <div id="pat-search-bar" className="mb-12">
                  <ComponentLabel>
                    {tI18nHardcoded.raw('i18nComplete.text8b46aff86ab6')}
                  </ComponentLabel>
                  <ComponentDesc>
                    {tHardcodedUi.raw(
                      'appHomeDesignSystemPage.line2156JsxTextStandardSearchPillPlacedInTheActionBar',
                    )}
                    <code className="font-mono text-xs">max-w-md</code>
                    {tHardcodedUi.raw(
                      'appHomeDesignSystemPage.line2157JsxTextWidthSoItSitsNextToARight',
                    )}
                  </ComponentDesc>
                  <DemoContainer>
                    <div className="flex items-center justify-between gap-4">
                      <PageSearchBar
                        value=""
                        onChange={() => {}}
                        placeholder={tHardcodedUi.raw(
                          'appHomeDesignSystemPage.line2166JsxAttrPlaceholderSearchConnections',
                        )}
                        className="max-w-md"
                      />
                      <Button size="sm" className="gap-1.5">
                        <Plus className="h-3.5 w-3.5" />
                        {tI18nHardcoded.raw('i18nComplete.text18fdd549b2ed')}
                      </Button>
                    </div>
                  </DemoContainer>
                </div>
              </CollapsibleSection>

              <CollapsibleSection
                id="patterns"
                label={tI18nHardcoded.raw('i18nComplete.text70929371c10c')}
                summary={tI18nHardcoded.raw('i18nComplete.textc4f980147c40')}
              >
                <p className="text-muted-foreground mb-8 text-base leading-relaxed">
                  {tHardcodedUi.raw(
                    'appHomeDesignSystemPage.line2205JsxTextSmallCompositionPiecesUsedInsideProjectPagesIssue',
                  )}
                </p>

                {/* ── PageShell ── */}
                <div id="pat-page-shell" className="mb-12">
                  <ComponentLabel>
                    {tI18nHardcoded.raw('i18nComplete.text45b37f9e9c85')}
                  </ComponentLabel>
                  <ComponentDesc>
                    {tHardcodedUi.raw(
                      'appHomeDesignSystemPage.line2214JsxTextTheOneLayoutWrapperStandardisesMaxWidthHorizontal',
                    )}{' '}
                    <code className="font-mono text-xs">
                      {tHardcodedUi.raw('appHomeDesignSystemPage.line2216JsxTextReading720')}
                    </code>
                    ,{' '}
                    <code className="font-mono text-xs">
                      {tHardcodedUi.raw('appHomeDesignSystemPage.line2217JsxTextDefault1000')}
                    </code>
                    ,{' '}
                    <code className="font-mono text-xs">
                      {tHardcodedUi.raw('appHomeDesignSystemPage.line2218JsxTextWide1280')}
                    </code>
                    , <code className="font-mono text-xs">full</code>.
                  </ComponentDesc>
                  <DemoContainer>
                    <div className="border-border/60 text-muted-foreground rounded-lg border border-dashed py-10 text-center text-xs">
                      <code>
                        {tHardcodedUi.raw(
                          'appHomeDesignSystemPage.line2223JsxTextLtPageshellWidthQuotDefaultQuotGtLt',
                        )}
                      </code>
                      <div className="mt-1 opacity-60">
                        {tHardcodedUi.raw(
                          'appHomeDesignSystemPage.line2224JsxTextMaxW1000pxPx6LgPx10',
                        )}
                      </div>
                    </div>
                  </DemoContainer>
                </div>

                {/* ── Section ── */}
                <div id="pat-section" className="mb-12">
                  <ComponentLabel>
                    {tI18nHardcoded.raw('i18nComplete.textdfca5da56b8c')}
                  </ComponentLabel>
                  <ComponentDesc>
                    {tHardcodedUi.raw(
                      'appHomeDesignSystemPage.line2233JsxTextLabelledSectionInsideAPageshellUppercaseMicroLabel',
                    )}
                  </ComponentDesc>
                  <DemoContainer>
                    <BrandSection label={tI18nHardcoded.raw('i18nComplete.text4efca0d10c5f')}>
                      <p className="text-foreground text-sm leading-relaxed">
                        {tHardcodedUi.raw(
                          'appHomeDesignSystemPage.line2241JsxTextDescriptionContentLivesHereSectionsSeparateConcernsOn',
                        )}
                      </p>
                    </BrandSection>
                    <BrandSection
                      label={tI18nHardcoded.raw('i18nComplete.text45989de49fb7')}
                      action={
                        <Button variant="ghost" size="sm" className="h-6 px-2 text-xs">
                          {tI18nHardcoded.raw('i18nComplete.text464c4ffd019e')}
                        </Button>
                      }
                    >
                      <p className="text-muted-foreground text-sm">
                        {tHardcodedUi.raw(
                          'appHomeDesignSystemPage.line2254JsxTextASecondSectionWithATrailingAction',
                        )}
                      </p>
                    </BrandSection>
                  </DemoContainer>
                </div>

                {/* ── Banned ── */}
                <div id="pat-banned" className="mb-12">
                  <ComponentLabel>Banned patterns</ComponentLabel>
                  <ComponentDesc>
                    These ship in the code base but the brand kit bans them. Do not add a new use.
                  </ComponentDesc>
                  <DemoContainer className="p-0">
                    {BANNED_PATTERNS.map((b) => (
                      <div
                        key={b.name}
                        className="border-border flex items-start gap-3 border-b px-4 py-3 last:border-b-0"
                      >
                        <X className="text-kortix-red mt-0.5 size-3 shrink-0" />
                        <div className="min-w-0 text-sm">
                          <code className="text-foreground font-mono text-xs">{b.name}</code>
                          <p className="text-muted-foreground mt-0.5 text-xs">
                            {b.why} Use {b.instead}.
                          </p>
                        </div>
                      </div>
                    ))}
                  </DemoContainer>
                </div>

                {/* ── Avatars ── */}
                <div id="pat-avatars" className="mb-12">
                  <ComponentLabel>
                    {tI18nHardcoded.raw('i18nComplete.textfedfdc14d4f7')}
                  </ComponentLabel>
                  <ComponentDesc>
                    {tHardcodedUi.raw('appHomeDesignSystemPage.line2316JsxTextOneRule')}
                    <strong>
                      {tHardcodedUi.raw(
                        'appHomeDesignSystemPage.line2316JsxTextPeopleAreRoundThingsAreSquare',
                      )}
                    </strong>
                    . <code>UserAvatar</code>
                    {tHardcodedUi.raw(
                      'appHomeDesignSystemPage.line2317JsxTextRendersACircularAvatarForAPersonThe',
                    )}{' '}
                    <strong>
                      {tHardcodedUi.raw(
                        'appHomeDesignSystemPage.line2319JsxTextNeutralMonochromeInitials',
                      )}
                    </strong>
                    {tHardcodedUi.raw(
                      'appHomeDesignSystemPage.line2319JsxTextNoColouredBackgrounds',
                    )}
                    <code>EntityAvatar</code>
                    {tHardcodedUi.raw(
                      'appHomeDesignSystemPage.line2320JsxTextRendersARoundedSquareTileForAccountsProjects',
                    )}
                  </ComponentDesc>
                  <DemoContainer className="space-y-5">
                    <div className="flex items-center gap-4">
                      <span className="text-muted-foreground w-24 text-xs tracking-wider uppercase">
                        {tI18nHardcoded.raw('i18nComplete.text7db20897053b')}
                      </span>
                      <UserAvatar
                        email={tHardcodedUi.raw(
                          'appHomeDesignSystemPage.line2330JsxAttrEmailAdaKortixAi',
                        )}
                        name="Ada Lovelace"
                        size="sm"
                      />
                      <UserAvatar
                        email={tHardcodedUi.raw(
                          'appHomeDesignSystemPage.line2331JsxAttrEmailGraceKortixAi',
                        )}
                        name="Grace Hopper"
                      />
                      <UserAvatar
                        email={tHardcodedUi.raw(
                          'appHomeDesignSystemPage.line2332JsxAttrEmailAlanKortixAi',
                        )}
                        name="Alan Turing"
                        size="lg"
                      />
                    </div>
                    <div className="flex items-center gap-4">
                      <span className="text-muted-foreground w-24 text-xs tracking-wider uppercase">
                        {tI18nHardcoded.raw('i18nComplete.text32b31975c6ca')}
                      </span>
                      <EntityAvatar
                        label={tHardcodedUi.raw(
                          'appHomeDesignSystemPage.line2338JsxAttrLabelAcmeAgi',
                        )}
                        size="sm"
                      />
                      <EntityAvatar label={tI18nHardcoded.raw('i18nComplete.textab54cf5e1d9d')} />
                      <EntityAvatar icon={FolderGit2} />
                      <EntityAvatar icon={Users} size="lg" />
                      {/* `emoji` beats both the icon and the initial, and drops the
                        chalk fill — the glyph is already the colour. */}
                      <EntityAvatar
                        label={tI18nHardcoded.raw('i18nComplete.text638e417f4255')}
                        emoji="🐢"
                      />
                      <EntityAvatar
                        label={tI18nHardcoded.raw('i18nComplete.text638e417f4255')}
                        emoji="🐢"
                        size="lg"
                      />
                    </div>
                    <div className="flex items-center gap-4">
                      <span className="text-muted-foreground w-24 text-xs tracking-wider uppercase">
                        {tI18nHardcoded.raw('i18nComplete.text78ea37549c37')}
                      </span>
                      {['Atlas', 'Beacon', 'Cobalt', 'Drift', 'Ember', 'Forge', 'Glacier'].map(
                        (label) => (
                          <EntityAvatar key={label} label={label} />
                        ),
                      )}
                    </div>
                  </DemoContainer>
                </div>

                {/* ── DefinitionList ── */}
                <div id="pat-definition-list" className="mb-12">
                  <ComponentLabel>
                    {tI18nHardcoded.raw('i18nComplete.text3f9ff5e181e9')}
                  </ComponentLabel>
                  <ComponentDesc>
                    {tHardcodedUi.raw(
                      'appHomeDesignSystemPage.line2403JsxTextKeyValuePairsFixedWidthLabelColumnSo',
                    )}
                  </ComponentDesc>
                  <DemoContainer>
                    <DefinitionList dividers>
                      <DefinitionRow label={tI18nHardcoded.raw('i18nComplete.text62fa5a5b0d3c')}>
                        <code className="text-foreground font-mono text-xs">
                          /workspace/jjk-domain-search
                        </code>
                      </DefinitionRow>
                      <DefinitionRow label={tI18nHardcoded.raw('i18nComplete.textd70b9e24bca2')}>
                        {tHardcodedUi.raw('appHomeDesignSystemPage.line2413JsxTextText2DaysAgo')}
                      </DefinitionRow>
                      <DefinitionRow label={tI18nHardcoded.raw('i18nComplete.text3a5ecca188c0')}>
                        <span className="tabular-nums">
                          {tHardcodedUi.raw('appHomeDesignSystemPage.line2415JsxTextText3mAgo')}
                        </span>
                      </DefinitionRow>
                      <DefinitionRow label={tI18nHardcoded.raw('i18nComplete.text6fa3cbf451b2')}>
                        8
                      </DefinitionRow>
                    </DefinitionList>
                  </DemoContainer>
                </div>

                {/* ── InlineMeta ── */}
                <div id="pat-inline-meta" className="mb-12">
                  <ComponentLabel>
                    {tI18nHardcoded.raw('i18nComplete.text053805aad93b')}
                  </ComponentLabel>
                  <ComponentDesc>
                    {tHardcodedUi.raw(
                      'appHomeDesignSystemPage.line2426JsxTextDotSeparatedFactsDropAnyNumberOfChildren',
                    )}
                  </ComponentDesc>
                  <DemoContainer>
                    <InlineMeta>
                      <span className="text-foreground font-mono">
                        {tI18nHardcoded.raw('i18nComplete.textde996979df5c')}
                      </span>
                      <span>
                        {tHardcodedUi.raw('appHomeDesignSystemPage.line2435JsxTextText24Issues')}
                      </span>
                      <span>
                        {tHardcodedUi.raw('appHomeDesignSystemPage.line2436JsxTextCreated2dAgo')}
                      </span>
                      <span>
                        {tHardcodedUi.raw('appHomeDesignSystemPage.line2437JsxTextText8Sessions')}
                      </span>
                    </InlineMeta>
                  </DemoContainer>
                </div>

                {/* ── EmptyState ── */}
                <div id="pat-empty-state" className="mb-12">
                  <ComponentLabel>
                    {tI18nHardcoded.raw('i18nComplete.texta422df8c8b26')}
                  </ComponentLabel>
                  <ComponentDesc>
                    {tHardcodedUi.raw(
                      'appHomeDesignSystemPage.line2446JsxTextTheCalmTeachingMomentIconHeadlineOneLine',
                    )}
                  </ComponentDesc>
                  <DemoContainer className="p-0">
                    <EmptyState
                      icon={IconInbox}
                      title={tHardcodedUi.raw(
                        'appHomeDesignSystemPage.line2453JsxAttrTitleNoIssuesYet',
                      )}
                      description={tHardcodedUi.raw(
                        'appHomeDesignSystemPage.line2454JsxAttrDescriptionCreateYourFirstIssueWithCOrImport',
                      )}
                      action={
                        <Button size="sm" className="h-8 px-4 text-sm">
                          {tHardcodedUi.raw('appHomeDesignSystemPage.line2457JsxTextNewIssue')}
                        </Button>
                      }
                      secondaryAction={
                        <Button variant="ghost" size="sm" className="h-8 px-3 text-sm">
                          {tHardcodedUi.raw('appHomeDesignSystemPage.line2462JsxTextLearnMore')}
                        </Button>
                      }
                    />
                  </DemoContainer>
                </div>

                {/* ── InfoBanner ── */}
                <div id="pat-info-banner" className="mb-12">
                  <ComponentLabel>
                    {tI18nHardcoded.raw('i18nComplete.text17df71c477b7')}
                  </ComponentLabel>
                  <ComponentDesc>
                    {tHardcodedUi.raw(
                      'appHomeDesignSystemPage.line2473JsxTextAnInlineStatusInfoNoticeManifestStatusA',
                    )}
                    <code>tone</code>
                    {tHardcodedUi.raw(
                      'appHomeDesignSystemPage.line2474JsxTextNeutralInfoSuccessWarningDestructiveInsteadOfHand',
                    )}
                  </ComponentDesc>
                  <DemoContainer className="space-y-3">
                    <InfoBanner
                      tone="info"
                      icon={Info}
                      title={tHardcodedUi.raw(
                        'appHomeDesignSystemPage.line2479JsxAttrTitleHeadsUp',
                      )}
                    >
                      {tHardcodedUi.raw(
                        'appHomeDesignSystemPage.line2480JsxTextTheManifestIsBeingReSyncedSecretsApply',
                      )}
                    </InfoBanner>
                    <InfoBanner
                      tone="warning"
                      icon={TriangleAlert}
                      title={tHardcodedUi.raw(
                        'appHomeDesignSystemPage.line2482JsxAttrTitleEmailSkipped',
                      )}
                    >
                      {tHardcodedUi.raw(
                        'appHomeDesignSystemPage.line2483JsxTextMailtrapIsnAposTConfiguredLocallyCopyThe',
                      )}
                    </InfoBanner>
                    <InfoBanner
                      tone="success"
                      icon={Check}
                      title={tHardcodedUi.raw('appHomeDesignSystemPage.line2488JsxAttrTitleAllSet')}
                      action={
                        <Button size="sm" variant="ghost" className="h-7 px-2 text-xs">
                          {tI18nHardcoded.raw('i18nComplete.text48845bff334a')}
                        </Button>
                      }
                    >
                      {tHardcodedUi.raw(
                        'appHomeDesignSystemPage.line2495JsxTextYourRepositoryIsConnected',
                      )}
                    </InfoBanner>
                  </DemoContainer>
                </div>

                <div id="pat-status" className="mb-12">
                  <ComponentLabel>
                    {tHardcodedUi.raw(
                      'appHomeDesignSystemPage.line2501JsxTextStatusDotBadgeAmpDiffstat',
                    )}
                  </ComponentLabel>
                  <ComponentDesc>
                    {tHardcodedUi.raw(
                      'appHomeDesignSystemPage.line2503JsxTextTheSingleSourceOfTruthForLdquoThis',
                    )}{' '}
                    <code>Badge</code>
                    {tHardcodedUi.raw('appHomeDesignSystemPage.line2505JsxTextBoxesUse')}
                    <code>InfoBanner</code>
                    {tHardcodedUi.raw(
                      'appHomeDesignSystemPage.line2505JsxTextForTheCasesAComponentCanAposT',
                    )}
                    <code>StatusDot</code>, <code>DiffStat</code>
                    {tHardcodedUi.raw('appHomeDesignSystemPage.line2508JsxTextOrThe')}
                    <code>STATUS_TEXT/BG/BORDER</code>{' '}
                    {tHardcodedUi.raw(
                      'appHomeDesignSystemPage.line2509JsxTextMapsInsteadOfReInlining',
                    )}
                    <code>{'text-<palette>-500'}</code>.
                  </ComponentDesc>
                  <DemoContainer className="flex flex-col gap-4">
                    <div className="flex items-center gap-4 text-sm">
                      <span className="inline-flex items-center gap-1.5">
                        <StatusDot tone="success" />{' '}
                        {tI18nHardcoded.raw('i18nComplete.textab0171ca0494')}
                      </span>
                      <span className="inline-flex items-center gap-1.5">
                        <StatusDot tone="success" pulse />{' '}
                        {tI18nHardcoded.raw('i18nComplete.textf4ccae29e1bb')}
                      </span>
                      <span className="inline-flex items-center gap-1.5">
                        <StatusDot tone="warning" />{' '}
                        {tI18nHardcoded.raw('i18nComplete.texte981ddae45d8')}
                      </span>
                      <span className="inline-flex items-center gap-1.5">
                        <StatusDot tone="destructive" />{' '}
                        {tI18nHardcoded.raw('i18nComplete.text54a0e8c17ebb')}
                      </span>
                      <span className="inline-flex items-center gap-1.5">
                        <StatusDot tone="info" />{' '}
                        {tI18nHardcoded.raw('i18nComplete.text170322a32f3c')}
                      </span>
                    </div>
                    <div className="flex items-center gap-4 text-sm">
                      <DiffStat additions={42} deletions={7} />
                      <DiffStat additions={12} />
                      <DiffStat deletions={3} />
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusBadge tone="success">
                        {tHardcodedUi.raw('appHomeDesignSystemPage.line2535JsxTextText3Passed')}
                      </StatusBadge>
                      <StatusBadge tone="warning">
                        {tHardcodedUi.raw('appHomeDesignSystemPage.line2536JsxTextText5Warnings')}
                      </StatusBadge>
                      <StatusBadge tone="destructive">
                        {tHardcodedUi.raw('appHomeDesignSystemPage.line2537JsxTextText2Errors')}
                      </StatusBadge>
                      <StatusBadge tone="info">
                        {tI18nHardcoded.raw('i18nComplete.texte8ce5dcaf408')}
                      </StatusBadge>
                      <StatusBadge tone="neutral">
                        {tI18nHardcoded.raw('i18nComplete.textab0171ca0494')}
                      </StatusBadge>
                    </div>
                    <p className="text-muted-foreground text-xs">
                      {tI18nHardcoded.raw('i18nComplete.textc36d819e7bc6')} <code>StatusBadge</code>
                      {tHardcodedUi.raw(
                        'appHomeDesignSystemPage.line2542JsxTextForInformationalStatusFaintInclRed',
                      )}
                      <code>
                        {tHardcodedUi.raw(
                          'appHomeDesignSystemPage.line2543JsxTextBadgeVariantQuotDestructiveQuot',
                        )}
                      </code>{' '}
                      {tHardcodedUi.raw(
                        'appHomeDesignSystemPage.line2544JsxTextIsASolidRedPillReserveItFor',
                      )}
                    </p>
                  </DemoContainer>
                </div>
              </CollapsibleSection>

              <CollapsibleSection
                id="anti-patterns"
                label={tI18nHardcoded.raw('i18nComplete.text8d2be39d6187')}
                summary={tI18nHardcoded.raw('i18nComplete.text067ed033e4a6')}
              >
                <p className="text-muted-foreground mb-8 text-base leading-relaxed">
                  {tHardcodedUi.raw(
                    'appHomeDesignSystemPage.line2557JsxTextCodePatternsThatViolateTheDesignSystemFollow',
                  )}
                </p>

                <div className="space-y-6">
                  <AntiPatternBlock
                    title={tHardcodedUi.raw(
                      'appHomeDesignSystemPage.line2564JsxAttrTitleAp1NoInlineStyleForFixedValues',
                    )}
                    description={tHardcodedUi.raw(
                      'appHomeDesignSystemPage.line2565JsxAttrDescriptionBypassesTheUtilitySystemCanTBePurged',
                    )}
                    bad={tI18nHardcoded.raw('i18nComplete.text8814f18c10c8')}
                    good={tI18nHardcoded.raw('i18nComplete.text042ce1942693')}
                  />

                  <AntiPatternBlock
                    title={tHardcodedUi.raw(
                      'appHomeDesignSystemPage.line2571JsxAttrTitleAp2NoArbitraryTextSizes',
                    )}
                    description={tHardcodedUi.raw(
                      'appHomeDesignSystemPage.line2572JsxAttrDescriptionCreatesInconsistentTypeSizesWithNoSemanticMeaning',
                    )}
                    bad={
                      tI18nHardcoded.raw('i18nComplete.text4f4c5e40c2e8') +
                      tI18nHardcoded.raw('i18nComplete.text92600913f25b') +
                      tI18nHardcoded.raw('i18nComplete.text10e4622539f8') +
                      '[0.875em]">Body</span>'
                    }
                    good={tI18nHardcoded.raw('i18nComplete.texteba19c8747ae')}
                  />

                  <AntiPatternBlock
                    title={tHardcodedUi.raw(
                      'appHomeDesignSystemPage.line2583JsxAttrTitleAp3NoRawButtonElements',
                    )}
                    description={tHardcodedUi.raw(
                      'appHomeDesignSystemPage.line2584JsxAttrDescriptionRawButtonsBypassVariantSystemHaveInconsistentSizing',
                    )}
                    bad={tI18nHardcoded.raw('i18nComplete.text4fbe0827517d')}
                    good={tI18nHardcoded.raw('i18nComplete.text2b00ca23b112')}
                  />

                  <AntiPatternBlock
                    title={tHardcodedUi.raw(
                      'appHomeDesignSystemPage.line2590JsxAttrTitleAp4NoTransitionColors',
                    )}
                    description={tHardcodedUi.raw(
                      'appHomeDesignSystemPage.line2591JsxAttrDescriptionAnimatesEveryCssPropertyIncludingWidthHeightPadding',
                    )}
                    bad={tI18nHardcoded.raw('i18nComplete.textef09f3cb9afd')}
                    good={tI18nHardcoded.raw('i18nComplete.text6b84bc014a9f')}
                  />

                  <AntiPatternBlock
                    title={tHardcodedUi.raw(
                      'appHomeDesignSystemPage.line2597JsxAttrTitleAp5NoHardcodedHexColors',
                    )}
                    description={tHardcodedUi.raw(
                      'appHomeDesignSystemPage.line2598JsxAttrDescriptionCompletelyBypassesTheThemeSystemWillLookWrong',
                    )}
                    bad={tI18nHardcoded.raw('i18nComplete.text9b68117141f2')}
                    good={tI18nHardcoded.raw('i18nComplete.text9e5ea6b4c372')}
                  />

                  <AntiPatternBlock
                    title={tHardcodedUi.raw(
                      'appHomeDesignSystemPage.line2604JsxAttrTitleAp6NoClickableDivElements',
                    )}
                    description={tHardcodedUi.raw(
                      'appHomeDesignSystemPage.line2605JsxAttrDescriptionNotKeyboardAccessibleNoFocusRingNotAnnounced',
                    )}
                    bad={tI18nHardcoded.raw('i18nComplete.textdd93abf29136')}
                    good={tI18nHardcoded.raw('i18nComplete.text525174cc0d8d')}
                  />
                </div>
              </CollapsibleSection>

              <CollapsibleSection
                id="usage"
                label={tI18nHardcoded.raw('i18nComplete.text8d59829c1e15')}
                summary={tI18nHardcoded.raw('i18nComplete.text0b2657a2d044')}
              >
                <div className="grid gap-10 md:grid-cols-2">
                  <div>
                    <p className="text-muted-foreground mb-4 text-xs font-medium">
                      {tI18nHardcoded.raw('i18nComplete.text30094e0bec00')}
                    </p>
                    {[
                      tI18nHardcoded.raw('i18nComplete.textf54a674cd9e6'),
                      tI18nHardcoded.raw('i18nComplete.textb8bad1ee3036'),
                      tI18nHardcoded.raw('i18nComplete.text64f160413fef'),
                      tI18nHardcoded.raw('i18nComplete.textdc54941c8b98'),
                      tI18nHardcoded.raw('i18nComplete.text43d8ab235dde'),
                      tI18nHardcoded.raw('i18nComplete.text88f3c1c6662e'),
                      tI18nHardcoded.raw('i18nComplete.textfd0b25a736aa'),
                      tI18nHardcoded.raw('i18nComplete.textb4568bcc15f8'),
                      tI18nHardcoded.raw('i18nComplete.text659344748c8e'),
                      tI18nHardcoded.raw('i18nComplete.text1329b0068f14'),
                    ].map((t) => (
                      <div
                        key={t}
                        className="border-border/30 flex items-start gap-2.5 border-b py-2"
                      >
                        <span className="bg-kortix-green/15 mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full">
                          <Check className="text-kortix-green size-2.5" />
                        </span>
                        <span className="text-muted-foreground text-sm">{t}</span>
                      </div>
                    ))}
                  </div>
                  <div>
                    <p className="text-muted-foreground mb-4 text-xs font-medium">
                      {tI18nHardcoded.raw('i18nComplete.text24b6bef25e6e')}
                      {"'"}t
                    </p>
                    {[
                      tI18nHardcoded.raw('i18nComplete.textb2a0575f2c15'),
                      tI18nHardcoded.raw('i18nComplete.text3968b17ec8ee'),
                      tI18nHardcoded.raw('i18nComplete.text8ac2997f797e'),
                      tI18nHardcoded.raw('i18nComplete.text8a280803e026'),
                      tI18nHardcoded.raw('i18nComplete.textc21f6265f30c'),
                      tI18nHardcoded.raw('i18nComplete.text787c76603041'),
                      tI18nHardcoded.raw('i18nComplete.text4fb7aff6ff92'),
                      tI18nHardcoded.raw('i18nComplete.textb5845e7eea2b'),
                      tI18nHardcoded.raw('i18nComplete.text97a6a4e757fa'),
                      tI18nHardcoded.raw('i18nComplete.textb2e30caf44ee'),
                    ].map((t) => (
                      <div
                        key={t}
                        className="border-border/30 flex items-start gap-2.5 border-b py-2"
                      >
                        <span className="bg-kortix-red/15 mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full">
                          <X className="text-kortix-red size-2.5" />
                        </span>
                        <span className="text-muted-foreground text-sm">{t}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </CollapsibleSection>

              <CollapsibleSection
                id="icons"
                label={tI18nHardcoded.raw('i18nComplete.texteae96e02bbc4')}
                summary={tI18nHardcoded.raw('i18nComplete.textfbb883595364')}
              >
                <IconsSection />
              </CollapsibleSection>

              <CollapsibleSection
                id="confetti"
                label={tI18nHardcoded.raw('i18nComplete.text2b54343f65e9')}
                summary={tI18nHardcoded.raw('i18nComplete.textcfca1e280a8c')}
              >
                <ConfettiSection />
              </CollapsibleSection>
            </Accordion>
          </div>
        </div>
      </div>
    </main>
  );
}
