'use client';

import { useTranslations } from 'next-intl';

import { cn } from '@/lib/utils';
import {
  AlertCircle,
  AlertTriangle,
  ArrowRight,
  Bold,
  Check,
  ChevronsUpDown,
  Copy,
  Download,
  FolderGit2,
  HelpCircle,
  Info,
  Loader2,
  Mail,
  MoreHorizontal,
  Plus,
  Search,
  Settings,
  Star,
  Trash2,
  TriangleAlert,
  Users,
  X,
} from 'lucide-react';
import { useEffect, useState } from 'react';

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
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
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { EmptyState } from '@/components/ui/empty-state';
import { EntityAvatar } from '@/components/ui/entity-avatar';
import { InfoBanner } from '@/components/ui/info-banner';
import { InlineMeta } from '@/components/ui/inline-meta';
import { Input } from '@/components/ui/input';
import { Kbd, KbdGroup } from '@/components/ui/kbd';
import { IconInbox } from '@/components/ui/kortix-icons';
import { Label } from '@/components/ui/label';
import { List, ListRow } from '@/components/ui/list';
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
import { PageHeader } from '@/components/ui/page-header';
import { PageSearchBar } from '@/components/ui/page-search-bar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Progress } from '@/components/ui/progress';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Section as BrandSection } from '@/components/ui/section';
import { SectionCard } from '@/components/ui/section-card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
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
import { Toggle } from '@/components/ui/toggle';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { UserAvatar } from '@/components/ui/user-avatar';
import { Cable, Plug, Radio, Zap } from 'lucide-react';

/* ─────────────────────── Data ─────────────────────── */

const BRAND_COLORS = [
  { name: 'Black', hex: '#000000', oklch: 'oklch(0 0 0)', light: false },
  {
    name: 'Off-Black',
    hex: '#1A1A1A',
    oklch: 'oklch(0.145 0 0)',
    light: false,
  },
  { name: 'White', hex: '#FFFFFF', oklch: 'oklch(1 0 0)', light: true },
  { name: 'Off-White', hex: '#F5F5F5', oklch: 'oklch(0.965 0 0)', light: true },
] as const;

/**
 * Core theme palette — mirrors exactly the CSS custom properties defined in
 * `:root` (light) and `.dark` in apps/web/src/app/globals.css.
 * This is the single source of truth displayed on the /brand page.
 * If you change a token in globals.css, change it here too.
 */
const CORE_PALETTE = [
  {
    name: 'Background',
    var: '--background',
    light: 'oklch(1 0 0)',
    dark: 'oklch(0.145 0 0)',
  },
  {
    name: 'Foreground',
    var: '--foreground',
    light: 'oklch(0.145 0 0)',
    dark: 'oklch(0.94 0 0)',
  },
  {
    name: 'Card',
    var: '--card',
    light: 'oklch(0.99 0 0)',
    dark: 'oklch(0.21 0 0)',
  },
  {
    name: 'Card Foreground',
    var: '--card-foreground',
    light: 'oklch(0.145 0 0)',
    dark: 'oklch(0.94 0 0)',
  },
  {
    name: 'Popover',
    var: '--popover',
    light: 'oklch(1 0 0)',
    dark: 'oklch(0.24 0 0)',
  },
  {
    name: 'Popover Foreground',
    var: '--popover-foreground',
    light: 'oklch(0.145 0 0)',
    dark: 'oklch(0.94 0 0)',
  },
  {
    name: 'Primary',
    var: '--primary',
    light: 'oklch(0.205 0 0)',
    dark: 'oklch(0.94 0 0)',
  },
  {
    name: 'Primary Foreground',
    var: '--primary-foreground',
    light: 'oklch(0.985 0 0)',
    dark: 'oklch(0.18 0 0)',
  },
  {
    name: 'Secondary',
    var: '--secondary',
    light: 'oklch(0.46 0 0)',
    dark: 'oklch(0.55 0.01 260)',
  },
  {
    name: 'Secondary Foreground',
    var: '--secondary-foreground',
    light: 'oklch(1 0 0)',
    dark: 'oklch(0.94 0 0)',
  },
  {
    name: 'Muted',
    var: '--muted',
    light: 'oklch(0.955 0 0)',
    dark: 'oklch(0.27 0 0)',
  },
  {
    name: 'Muted Foreground',
    var: '--muted-foreground',
    light: 'oklch(0.45 0 0)',
    dark: 'oklch(0.60 0 0)',
  },
  {
    name: 'Accent',
    var: '--accent',
    light: 'oklch(0.96 0 0)',
    dark: 'oklch(0.25 0 0)',
  },
  {
    name: 'Accent Foreground',
    var: '--accent-foreground',
    light: 'oklch(0.145 0 0)',
    dark: 'oklch(0.94 0 0)',
  },
  {
    name: 'Border',
    var: '--border',
    light: 'oklch(0.885 0 0)',
    dark: 'oklch(0.30 0 0)',
  },
  {
    name: 'Input',
    var: '--input',
    light: 'oklch(0.905 0 0)',
    dark: 'oklch(0.27 0 0)',
  },
  {
    name: 'Ring',
    var: '--ring',
    light: 'oklch(0.708 0 0)',
    dark: 'oklch(0.50 0 0)',
  },
  {
    name: 'Destructive',
    var: '--destructive',
    light: 'oklch(0.577 0.245 27.325)',
    dark: 'oklch(0.396 0.141 25.723)',
  },
] as const;

type LogoFormat = 'svg' | 'png';

interface LogoAsset {
  id: string;
  label: string;
  variant: string;
  svgSrc: string;
  pngSrc: string;
  dark: boolean;
}

const LOGO_ASSETS: LogoAsset[] = [
  {
    id: 'brandmark-black',
    label: 'Symbol',
    variant: 'Black',
    svgSrc: '/brandkit/Logo/Brandmark/SVG/Brandmark Black.svg',
    pngSrc: '/brandkit/Logo/Brandmark/PNG/Brandmark Black.png',
    dark: false,
  },
  {
    id: 'brandmark-white',
    label: 'Symbol',
    variant: 'White',
    svgSrc: '/brandkit/Logo/Brandmark/SVG/Brandmark White.svg',
    pngSrc: '/brandkit/Logo/Brandmark/PNG/Brandmark White.png',
    dark: true,
  },
  {
    id: 'wordmark-black',
    label: 'Wordmark',
    variant: 'Black',
    svgSrc: '/brandkit/Logo/Wordmark/SVG/Wordmark Black.svg',
    pngSrc: '/brandkit/Logo/Wordmark/PNG/Wordmark Black.png',
    dark: false,
  },
  {
    id: 'wordmark-white',
    label: 'Wordmark',
    variant: 'White',
    svgSrc: '/brandkit/Logo/Wordmark/SVG/Wordmark White.svg',
    pngSrc: '/brandkit/Logo/Wordmark/PNG/Wordmark White.png',
    dark: true,
  },
];

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

const TYPE_SCALE = [
  {
    token: 'text-xs',
    size: '0.75rem',
    px: '~12px',
    twClass: 'text-xs',
    use: 'Secondary labels, tooltips, KBD',
  },
  {
    token: 'text-sm',
    size: '0.875rem',
    px: '~14px',
    twClass: 'text-sm',
    use: 'Body text, menu items',
  },
  {
    token: 'text-base',
    size: '1rem',
    px: '~16px',
    twClass: 'text-base',
    use: 'Default UI text, inputs',
  },
  {
    token: 'text-lg',
    size: '1.125rem',
    px: '~18px',
    twClass: 'text-lg',
    use: 'Section headers, dialog titles',
  },
  {
    token: 'text-xl',
    size: '1.25rem',
    px: '~20px',
    twClass: 'text-xl',
    use: 'Page section titles',
  },
  {
    token: 'text-2xl',
    size: '1.5rem',
    px: '~24px',
    twClass: 'text-2xl',
    use: 'Page titles',
  },
  {
    token: 'text-3xl',
    size: '1.875rem',
    px: '~30px',
    twClass: 'text-3xl',
    use: 'Hero subheadings',
  },
  {
    token: 'text-4xl',
    size: '2.25rem',
    px: '~36px',
    twClass: 'text-4xl',
    use: 'Display / hero headings',
  },
  {
    token: 'text-5xl',
    size: '3rem',
    px: '~48px',
    twClass: 'text-5xl',
    use: 'Marketing display',
  },
  {
    token: 'text-6xl',
    size: '3.75rem',
    px: '~60px',
    twClass: 'text-6xl',
    use: 'Large display',
  },
  {
    token: 'text-7xl',
    size: '4.5rem',
    px: '~72px',
    twClass: 'text-7xl',
    use: 'Oversized display',
  },
  {
    token: 'text-8xl',
    size: '6rem',
    px: '~96px',
    twClass: 'text-8xl',
    use: 'Hero numerals / clocks',
  },
] as const;

const MOTION_DURATIONS = [
  { name: 'Fast', token: '--duration-fast', ms: 100 },
  { name: 'Normal', token: '--duration-normal', ms: 150 },
  { name: 'Moderate', token: '--duration-moderate', ms: 200 },
  { name: 'Slow', token: '--duration-slow', ms: 300 },
  { name: 'Slower', token: '--duration-slower', ms: 500 },
] as const;

const EASING_CURVES = [
  {
    name: 'Default',
    token: '--ease-default',
    value: 'cubic-bezier(0.2, 0, 0, 1)',
  },
  { name: 'Ease In', token: '--ease-in', value: 'cubic-bezier(0.4, 0, 1, 1)' },
  {
    name: 'Ease Out',
    token: '--ease-out',
    value: 'cubic-bezier(0, 0, 0.2, 1)',
  },
  {
    name: 'Ease In-Out',
    token: '--ease-in-out',
    value: 'cubic-bezier(0.4, 0, 0.2, 1)',
  },
] as const;

const SPACING_SCALE = [
  { token: '0.5', px: 2 },
  { token: '1', px: 4 },
  { token: '1.5', px: 6 },
  { token: '2', px: 8 },
  { token: '3', px: 12 },
  { token: '4', px: 16 },
  { token: '5', px: 20 },
  { token: '6', px: 24 },
  { token: '8', px: 32 },
  { token: '10', px: 40 },
  { token: '12', px: 48 },
  { token: '16', px: 64 },
] as const;

const TOC_SECTIONS = [
  { id: 'hero', label: 'Overview' },
  { id: 'logo', label: 'Logo' },
  { id: 'colors', label: 'Colors' },
  { id: 'typography', label: 'Typography' },
  { id: 'motion', label: 'Motion' },
  { id: 'spacing', label: 'Spacing' },
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
      { id: 'comp-checkbox', label: 'Checkbox' },
      { id: 'comp-switch', label: 'Switch' },
      { id: 'comp-toggle', label: 'Toggle' },
      { id: 'comp-radio', label: 'Radio Group' },
      { id: 'comp-tabs', label: 'Tabs' },
      { id: 'comp-dialog', label: 'Dialog' },
      { id: 'comp-modal', label: 'Modal' },
      { id: 'comp-sheet', label: 'Sheet' },
      { id: 'comp-dropdown', label: 'Dropdown' },
      { id: 'comp-tooltip', label: 'Tooltip' },
      { id: 'comp-popover', label: 'Popover' },
      { id: 'comp-alert', label: 'Alert' },
      { id: 'comp-alert-dialog', label: 'Alert Dialog' },
      { id: 'comp-accordion', label: 'Accordion' },
      { id: 'comp-collapsible', label: 'Collapsible' },
      { id: 'comp-separator', label: 'Separator' },
      { id: 'comp-skeleton', label: 'Skeleton' },
      { id: 'comp-progress', label: 'Progress' },
      { id: 'comp-slider', label: 'Slider' },
      { id: 'comp-label', label: 'Label' },
      { id: 'comp-breadcrumb', label: 'Breadcrumb' },
      { id: 'comp-table', label: 'Table' },
      { id: 'comp-kbd', label: 'Kbd' },
      { id: 'comp-calendar', label: 'Calendar' },
      { id: 'comp-scrollarea', label: 'Scroll Area' },
    ],
  },
  {
    id: 'page-patterns',
    label: 'Page Patterns',
    children: [
      { id: 'pat-page-header', label: 'PageHeader' },
      { id: 'pat-spotlight-card', label: 'SpotlightCard' },
      { id: 'pat-search-bar', label: 'PageSearchBar' },
      { id: 'pat-stagger', label: 'Stagger Mount' },
    ],
  },
  {
    id: 'patterns',
    label: 'Primitives',
    children: [
      { id: 'pat-page-shell', label: 'PageShell' },
      { id: 'pat-section', label: 'Section' },
      { id: 'pat-section-card', label: 'SectionCard' },
      { id: 'pat-avatars', label: 'Avatars' },
      { id: 'pat-list', label: 'List & ListRow' },
      { id: 'pat-definition-list', label: 'DefinitionList' },
      { id: 'pat-inline-meta', label: 'InlineMeta' },
      { id: 'pat-empty-state', label: 'EmptyState' },
      { id: 'pat-info-banner', label: 'InfoBanner' },
      { id: 'pat-status', label: 'Status (Dot, Badge, Diff)' },
    ],
  },
  { id: 'anti-patterns', label: 'Anti-Patterns' },
  { id: 'usage', label: 'Usage' },
] as const;

/* All section IDs flattened for intersection observer */
const ALL_SECTION_IDS = TOC_SECTIONS.flatMap((s) =>
  'children' in s && s.children ? [s.id, ...s.children.map((c) => c.id)] : [s.id],
);

/* ─────────────────── Helper Components ─────────────────── */

function Hex({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
      className="group inline-flex cursor-pointer items-center gap-1.5"
    >
      <span className="text-muted-foreground group-hover:text-foreground font-mono text-xs transition-colors">
        {value}
      </span>
      {copied ? (
        <Check className="size-2.5 text-emerald-500" />
      ) : (
        <Copy className="text-muted-foreground group-hover:text-muted-foreground size-2.5 transition-colors" />
      )}
    </button>
  );
}

function LogoCard({ asset, fmt }: { asset: LogoAsset; fmt: LogoFormat }) {
  const isWordmark = asset.label === 'Wordmark';
  const downloadHref = fmt === 'png' ? asset.pngSrc : asset.svgSrc;
  const downloadName = `kortix-${asset.label.toLowerCase()}-${asset.variant.toLowerCase()}.${fmt}`;

  return (
    <div className="group relative">
      <div
        className={cn(
          'relative flex aspect-[3/2] items-center justify-center overflow-hidden rounded-lg transition-colors',
          isWordmark ? 'px-6 py-8' : 'p-10',
          asset.dark
            ? 'bg-neutral-950 ring-1 ring-white/[0.06]'
            : 'bg-white ring-1 ring-black/[0.06]',
        )}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={asset.svgSrc}
          alt={`Kortix ${asset.label} ${asset.variant}`}
          className={cn(
            'object-contain',
            isWordmark ? 'max-h-8 w-full md:max-h-10' : 'max-h-10 w-auto md:max-h-12',
          )}
        />

        <a
          href={downloadHref}
          download={downloadName}
          className="absolute inset-0 flex cursor-pointer items-center justify-center rounded-lg bg-black/[0.04] opacity-0 transition-opacity group-hover:opacity-100 dark:bg-white/[0.04]"
        >
          <span className="bg-background ring-border flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium shadow-sm ring-1">
            <Download className="size-3" /> {fmt.toUpperCase()}
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
    <div className={cn('ring-border/50 bg-card/30 rounded-xl p-6 ring-1', className)}>
      {children}
    </div>
  );
}

function SectionDivider() {
  return <div className="border-border/50 mt-14 border-t pt-8" />;
}

function ComponentLabel({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-muted-foreground mb-2 text-xs tracking-widest uppercase">{children}</h3>
  );
}

function ComponentDesc({ children }: { children: React.ReactNode }) {
  return <p className="text-muted-foreground mb-4 text-sm leading-relaxed">{children}</p>;
}

/* ─── Motion Demo ─── */

function MotionBar({
  label,
  durationMs,
  durationToken,
  easing = 'var(--ease-default)',
  easingToken,
}: {
  label: string;
  durationMs: number;
  durationToken?: string;
  easing?: string;
  easingToken?: string;
}) {
  const [active, setActive] = useState(false);

  const replay = () => {
    setActive(false);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => setActive(true));
    });
  };

  return (
    <div className="flex items-center gap-4">
      <button
        type="button"
        onClick={replay}
        className="text-muted-foreground hover:text-foreground w-24 shrink-0 cursor-pointer text-left font-mono text-xs transition-colors"
      >
        {label}
      </button>
      <div className="bg-muted/30 relative h-7 flex-1 overflow-hidden rounded-md">
        <div
          className="bg-foreground/70 absolute top-1 bottom-1 left-1 rounded-sm"
          style={{
            width: active ? 'calc(100% - 8px)' : '24px',
            transitionProperty: 'width',
            transitionDuration: durationToken ? `var(${durationToken})` : `${durationMs}ms`,
            transitionTimingFunction: easingToken ? `var(${easingToken})` : easing,
          }}
        />
      </div>
      <span className="text-muted-foreground w-14 shrink-0 text-right font-mono text-xs">
        {durationMs}ms
      </span>
    </div>
  );
}

/* ─── Anti-Pattern Code Block ─── */

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
    <div className="ring-border/50 overflow-hidden rounded-xl ring-1">
      <div className="border-border/30 border-b px-5 py-4">
        <h4 className="text-foreground text-sm font-medium">{title}</h4>
        <p className="text-muted-foreground mt-1 text-xs">{description}</p>
      </div>
      <div className="divide-border/30 grid divide-y md:grid-cols-2 md:divide-x md:divide-y-0">
        <div className="p-4">
          <div className="mb-2.5 flex items-center gap-1.5">
            <X className="size-3 text-red-500" />
            <span className="text-xs font-medium tracking-widest text-red-500/70 uppercase">
              {tHardcodedUi.raw('appHomeDesignSystemPage.line566JsxTextDonAposT')}
            </span>
          </div>
          <pre className="text-muted-foreground bg-muted/30 overflow-x-auto rounded-lg p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap">
            {bad}
          </pre>
        </div>
        <div className="p-4">
          <div className="mb-2.5 flex items-center gap-1.5">
            <Check className="size-3 text-emerald-500" />
            <span className="text-xs font-medium tracking-widest text-emerald-500/70 uppercase">
              Do
            </span>
          </div>
          <pre className="text-muted-foreground bg-muted/30 overflow-x-auto rounded-lg p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap">
            {good}
          </pre>
        </div>
      </div>
    </div>
  );
}

/* ─── TOC Sidebar ─── */

function TocSidebar() {
  const [activeId, setActiveId] = useState('hero');

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setActiveId(entry.target.id);
          }
        }
      },
      { rootMargin: '-20% 0px -70% 0px', threshold: 0 },
    );

    for (const id of ALL_SECTION_IDS) {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    }

    return () => observer.disconnect();
  }, []);

  /* Determine which parent section is active based on the current activeId */
  const activeParentId = TOC_SECTIONS.find((s) => {
    if (s.id === activeId) return true;
    if ('children' in s && s.children) {
      return s.children.some((c) => c.id === activeId);
    }
    return false;
  })?.id;

  return (
    <nav className="sticky top-20 hidden w-48 shrink-0 self-start pt-2 lg:block">
      <ul className="space-y-0.5">
        {TOC_SECTIONS.map((s) => {
          const isParentActive = s.id === activeParentId;
          const hasChildren = 'children' in s && s.children;
          return (
            <li key={s.id}>
              <a
                href={`#${s.id}`}
                className={cn(
                  'block py-1 text-sm transition-colors',
                  activeId === s.id || isParentActive
                    ? 'text-foreground font-medium'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {s.label}
              </a>
              {hasChildren && isParentActive && (
                <ul className="border-border/30 mt-0.5 mb-1 ml-2.5 space-y-0 border-l pl-2.5">
                  {s.children.map((c) => (
                    <li key={c.id}>
                      <a
                        href={`#${c.id}`}
                        className={cn(
                          'block py-0.5 text-sm transition-colors',
                          activeId === c.id
                            ? 'text-foreground font-medium'
                            : 'text-muted-foreground hover:text-foreground',
                        )}
                      >
                        {c.label}
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/* ───────────────────── Page ───────────────────── */

export default function BrandPage() {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const [logoFmt, setLogoFmt] = useState<LogoFormat>('svg');
  const [checkboxChecked, setCheckboxChecked] = useState(true);
  const [switchOn, setSwitchOn] = useState(true);
  const [switchOff, setSwitchOff] = useState(false);
  const [selectedDate, setSelectedDate] = useState<Date | undefined>(new Date());
  const [sliderValue, setSliderValue] = useState([50]);
  const [togglePressed, setTogglePressed] = useState(true);
  const [collapsibleOpen, setCollapsibleOpen] = useState(false);

  return (
    <main className="bg-background min-h-screen">
      <div className="mx-auto max-w-5xl px-6 pt-24 pb-24 sm:pt-32 sm:pb-32">
        <div className="flex gap-16">
          {/* TOC sidebar — desktop only */}
          <TocSidebar />

          {/* Main content */}
          <div className="max-w-3xl flex-1">
            {/* ═══════════════ Hero ═══════════════ */}
            <section id="hero">
              <div className="mb-3">
                <Badge variant="outline" className="font-mono text-xs">
                  v1.0
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
                  <span className="font-mono">30+</span> Components
                </Badge>
                <Badge variant="secondary">
                  <span className="font-mono">7</span> Themes
                </Badge>
                <Badge variant="secondary">
                  {tHardcodedUi.raw('appHomeDesignSystemPage.line714JsxTextOklchColors')}
                </Badge>
                <Badge variant="secondary">
                  {tHardcodedUi.raw('appHomeDesignSystemPage.line715JsxTextRadixPrimitives')}
                </Badge>
              </div>
            </section>

            {/* ═══════════════ Logo ═══════════════ */}
            <section id="logo" className="mt-14">
              <div className="mb-5 flex items-center justify-between">
                <h2 className="text-muted-foreground text-xs tracking-widest uppercase">Logo</h2>
                <FormatToggle value={logoFmt} onChange={setLogoFmt} />
              </div>
              <p className="text-muted-foreground mb-6 text-base leading-relaxed">
                {tHardcodedUi.raw(
                  'appHomeDesignSystemPage.line728JsxTextTwoFormsTheSymbolAndTheWordmarkEach',
                )}
              </p>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {LOGO_ASSETS.map((a) => (
                  <LogoCard key={a.id} asset={a} fmt={logoFmt} />
                ))}
              </div>
              <p className="text-muted-foreground mt-6 text-sm leading-relaxed">
                {tHardcodedUi.raw(
                  'appHomeDesignSystemPage.line737JsxTextTheSymbolIsDerivedFromTheLetterK',
                )}
                {"'"}
                {tHardcodedUi.raw(
                  'appHomeDesignSystemPage.line739JsxTextTPracticalNeverStretchRotateOrRecolorIt',
                )}
              </p>
            </section>

            {/* ═══════════════ Colors ═══════════════ */}
            <section id="colors">
              <SectionDivider />
              <h2 className="text-muted-foreground mb-5 text-xs tracking-widest uppercase">
                Colors
              </h2>
              <p className="text-muted-foreground mb-6 text-base leading-relaxed">
                {tHardcodedUi.raw(
                  'appHomeDesignSystemPage.line751JsxTextBlackAndWhiteIsTheFoundationEachUi',
                )}
              </p>

              {/* Foundation */}
              <div className="mb-8">
                <p className="text-muted-foreground mb-3 text-xs">Foundation</p>
                <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                  {BRAND_COLORS.map((c) => (
                    <div key={c.hex}>
                      <div
                        className={cn(
                          'aspect-[4/3] rounded-lg',
                          c.light ? 'ring-1 ring-black/[0.08]' : '',
                        )}
                        style={{ backgroundColor: c.hex }}
                      />
                      <div className="mt-2 space-y-0.5 px-0.5">
                        <span className="text-foreground text-xs font-medium">{c.name}</span>
                        <div className="flex flex-col">
                          <Hex value={c.hex} />
                          <Hex value={c.oklch} />
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Core palette — every token from globals.css (:root + .dark),
                    rendered with both light and dark swatches so the whole
                    theme is visible at a glance regardless of the current mode. */}
              <div>
                <div className="mb-3 flex items-baseline justify-between">
                  <p className="text-muted-foreground text-xs">
                    {tHardcodedUi.raw('appHomeDesignSystemPage.line791JsxTextCorePalette')}
                  </p>
                  <p className="text-muted-foreground/70 font-mono text-xs">
                    {tHardcodedUi.raw('appHomeDesignSystemPage.line794JsxTextGlobalsCssRootDark')}
                  </p>
                </div>
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                  {CORE_PALETTE.map((token) => (
                    <div
                      key={token.var}
                      className="border-border/50 overflow-hidden rounded-lg border"
                    >
                      <div className="grid h-14 grid-cols-2">
                        <div
                          className="relative ring-1 ring-black/[0.06] ring-inset"
                          style={{ backgroundColor: token.light }}
                        >
                          <span className="absolute bottom-1 left-2 font-mono text-xs tracking-widest text-black/55 uppercase">
                            light
                          </span>
                        </div>
                        <div
                          className="relative ring-1 ring-white/[0.06] ring-inset"
                          style={{ backgroundColor: token.dark }}
                        >
                          <span className="absolute bottom-1 left-2 font-mono text-xs tracking-widest text-white/55 uppercase">
                            dark
                          </span>
                        </div>
                      </div>
                      <div className="bg-background px-3 py-2.5">
                        <div className="mb-1 flex items-baseline justify-between gap-2">
                          <span className="text-foreground truncate text-xs font-medium">
                            {token.name}
                          </span>
                          <span className="text-muted-foreground shrink-0 font-mono text-xs">
                            {token.var}
                          </span>
                        </div>
                        <div className="flex items-center justify-between gap-2">
                          <Hex value={token.light} />
                          <Hex value={token.dark} />
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </section>

            {/* ═══════════════ Typography ═══════════════ */}
            <section id="typography">
              <SectionDivider />
              <h2 className="text-muted-foreground mb-5 text-xs tracking-widest uppercase">
                Typography
              </h2>
              <p className="text-muted-foreground mb-8 text-base leading-relaxed">
                {tHardcodedUi.raw(
                  'appHomeDesignSystemPage.line848JsxTextRoobertAGeometricSansSerifFontMedium500',
                )}
              </p>

              {/* Weight showcase */}
              <div className="space-y-6">
                {[
                  { label: 'Medium · 500', cls: 'font-medium' },
                  { label: 'Regular · 400', cls: 'font-normal' },
                ].map((s) => (
                  <div key={s.label} className="border-border/30 border-b pb-5">
                    <span className="text-muted-foreground mb-2 block font-mono text-xs tracking-widest">
                      {s.label}
                    </span>
                    <p className={cn('text-foreground text-3xl tracking-tight md:text-5xl', s.cls)}>
                      {tHardcodedUi.raw('appHomeDesignSystemPage.line871JsxTextKortixComputer')}
                    </p>
                  </div>
                ))}
              </div>

              {/* Mono showcase */}
              <div className="mt-6 rounded-lg bg-neutral-950 p-5 text-neutral-100 md:p-6">
                <span className="mb-3 block font-mono text-xs tracking-widest text-neutral-500">
                  {tHardcodedUi.raw('appHomeDesignSystemPage.line880JsxTextRoobertMono')}
                </span>
                <p className="font-mono text-lg tracking-tight md:text-2xl">
                  {tHardcodedUi.raw('appHomeDesignSystemPage.line883JsxTextConstAgentNewKortix')}
                </p>
                <p className="mt-4 font-mono text-xs text-neutral-600">
                  {tHardcodedUi.raw(
                    'appHomeDesignSystemPage.line886JsxTextAbcdefghijklmnopqrstuvwxyzAbcdefghijklmnopqrstuvwxyz0123456789',
                  )}
                </p>
              </div>

              {/* Type scale table */}
              <div className="mt-8">
                <p className="text-muted-foreground mb-4 text-xs">
                  {tHardcodedUi.raw('appHomeDesignSystemPage.line894JsxTextTypeScale')}
                </p>
                <div className="space-y-0">
                  {TYPE_SCALE.map((t) => (
                    <div
                      key={t.token}
                      className="border-border/20 flex items-baseline gap-4 border-b py-3"
                    >
                      <div className="w-24 shrink-0">
                        <span className="text-muted-foreground font-mono text-xs">{t.token}</span>
                      </div>
                      <div className="w-16 shrink-0">
                        <span className="text-muted-foreground font-mono text-xs">{t.px}</span>
                      </div>
                      <div className="min-w-0 flex-1">
                        <span
                          className="text-foreground block truncate font-medium"
                          style={{ fontSize: t.size }}
                        >
                          {tHardcodedUi.raw(
                            'appHomeDesignSystemPage.line917JsxTextTheQuickBrownFox',
                          )}
                        </span>
                      </div>
                      <div className="hidden max-w-48 shrink-0 sm:block">
                        <span className="text-muted-foreground block truncate text-xs">
                          {t.use}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </section>

            {/* ═══════════════ Motion ═══════════════ */}
            <section id="motion">
              <SectionDivider />
              <h2 className="text-muted-foreground mb-5 text-xs tracking-widest uppercase">
                Motion
              </h2>
              <p className="text-muted-foreground mb-6 text-base leading-relaxed">
                {tHardcodedUi.raw(
                  'appHomeDesignSystemPage.line938JsxTextStandardizedDurationAndEasingTokensEnsureEveryTransition',
                )}
              </p>

              {/* Duration scale */}
              <div className="mb-8">
                <p className="text-muted-foreground mb-4 text-xs">
                  {tHardcodedUi.raw('appHomeDesignSystemPage.line946JsxTextDurationScale')}
                </p>
                <DemoContainer>
                  <div className="space-y-3">
                    {MOTION_DURATIONS.map((d) => (
                      <MotionBar
                        key={d.token}
                        label={d.name}
                        durationMs={d.ms}
                        durationToken={d.token}
                      />
                    ))}
                  </div>
                </DemoContainer>
              </div>

              {/* Easing curves */}
              <div>
                <p className="text-muted-foreground mb-4 text-xs">
                  {tHardcodedUi.raw('appHomeDesignSystemPage.line964JsxTextEasingCurves')}
                </p>
                <DemoContainer>
                  <div className="space-y-3">
                    {EASING_CURVES.map((e) => (
                      <MotionBar
                        key={e.token}
                        label={e.name}
                        durationMs={300}
                        durationToken="--duration-slow"
                        easingToken={e.token}
                      />
                    ))}
                  </div>
                </DemoContainer>
              </div>
            </section>

            {/* ═══════════════ Spacing ═══════════════ */}
            <section id="spacing">
              <SectionDivider />
              <h2 className="text-muted-foreground mb-5 text-xs tracking-widest uppercase">
                Spacing
              </h2>
              <p className="text-muted-foreground mb-6 text-base leading-relaxed">
                {tHardcodedUi.raw(
                  'appHomeDesignSystemPage.line988JsxTextAConsistentSpacingScaleBasedOn4pxIncrements',
                )}
              </p>

              <DemoContainer>
                <div className="space-y-2.5">
                  {SPACING_SCALE.map((s) => (
                    <div key={s.token} className="flex items-center gap-4">
                      <span className="text-muted-foreground w-8 shrink-0 text-right font-mono text-xs">
                        {s.token}
                      </span>
                      <div
                        className="bg-foreground/60 h-5 rounded-sm"
                        style={{ width: `${s.px * 3}px` }}
                      />
                      <span className="text-muted-foreground font-mono text-xs">{s.px}px</span>
                    </div>
                  ))}
                </div>
              </DemoContainer>
            </section>

            {/* ═══════════════ Components ═══════════════ */}
            <section id="components">
              <SectionDivider />
              <h2 className="text-muted-foreground mb-5 text-xs tracking-widest uppercase">
                Components
              </h2>
              <p className="text-muted-foreground mb-8 text-base leading-relaxed">
                {tHardcodedUi.raw(
                  'appHomeDesignSystemPage.line1019JsxTextTheCompleteComponentLibraryEachComponentUsesA',
                )}
              </p>

              {/* ─── Button ─── */}
              <div id="comp-button" className="mb-12">
                <ComponentLabel>Button</ComponentLabel>
                <ComponentDesc>
                  {tHardcodedUi.raw(
                    'appHomeDesignSystemPage.line1029JsxTextText10Variants8SizesTheFoundationOfEvery',
                  )}
                  <code className="bg-muted rounded px-1 font-mono text-xs">rounded-full</code>
                  {tHardcodedUi.raw(
                    'appHomeDesignSystemPage.line1030JsxTextEveryContainerCardsDialogsInputsTextareasSelectsInfo',
                  )}
                  <code className="bg-muted rounded px-1 font-mono text-xs">rounded-2xl</code>
                  {tHardcodedUi.raw('appHomeDesignSystemPage.line1031JsxTextNeverPut')}
                  <code className="bg-muted rounded px-1 font-mono text-xs">
                    rounded-sm/md/lg/xl
                  </code>
                  {tHardcodedUi.raw('appHomeDesignSystemPage.line1032JsxTextOnABoxThe')}
                  <code className="bg-muted rounded px-1 font-mono text-xs">destructive</code>
                  {tHardcodedUi.raw(
                    'appHomeDesignSystemPage.line1033JsxTextVariantIsReservedForThe',
                  )}
                  <strong>
                    {tHardcodedUi.raw(
                      'appHomeDesignSystemPage.line1033JsxTextOneIrreversibleConfirm',
                    )}
                  </strong>
                  {tHardcodedUi.raw(
                    'appHomeDesignSystemPage.line1033JsxTextAConfirmdialogAposSPrimaryActionTheDanger',
                  )}
                </ComponentDesc>
                <DemoContainer>
                  <div className="space-y-6">
                    {/* Base Variants */}
                    <div>
                      <p className="text-muted-foreground mb-3 text-xs tracking-wider uppercase">
                        {tHardcodedUi.raw('appHomeDesignSystemPage.line1039JsxTextBaseVariants')}
                      </p>
                      <div className="flex flex-wrap gap-2">
                        <Button variant="default">Default</Button>
                        <Button variant="secondary">Secondary</Button>
                        <Button variant="destructive">Destructive</Button>
                        <Button variant="outline">Outline</Button>
                        <Button variant="ghost">Ghost</Button>
                        <Button variant="link">Link</Button>
                      </div>
                    </div>
                    {/* Kortix Variants */}
                    <div>
                      <p className="text-muted-foreground mb-3 text-xs tracking-wider uppercase">
                        {tHardcodedUi.raw('appHomeDesignSystemPage.line1051JsxTextKortixVariants')}
                      </p>
                      <div className="flex flex-wrap gap-2">
                        <Button variant="secondary">Secondary</Button>
                        <Button variant="muted">Muted</Button>
                        <Button variant="inverse">Inverse</Button>
                        <Button variant="success">Success</Button>
                      </div>
                    </div>
                    {/* Standard Sizes */}
                    <div>
                      <p className="text-muted-foreground mb-3 text-xs tracking-wider uppercase">
                        {tHardcodedUi.raw('appHomeDesignSystemPage.line1061JsxTextStandardSizes')}
                      </p>
                      <div className="flex flex-wrap items-center gap-2">
                        <Button size="lg">Large</Button>
                        <Button size="default">Default</Button>
                        <Button size="sm">Small</Button>
                        <Button size="icon">
                          <Settings className="size-4" />
                        </Button>
                      </div>
                    </div>
                    {/* Compact Sizes */}
                    <div>
                      <p className="text-muted-foreground mb-3 text-xs tracking-wider uppercase">
                        {tHardcodedUi.raw('appHomeDesignSystemPage.line1071JsxTextCompactSizes')}
                      </p>
                      <div className="flex flex-wrap items-center gap-2">
                        <Button size="toolbar" variant="muted">
                          Toolbar
                        </Button>
                        <Button size="xs" variant="muted">
                          XSmall
                        </Button>
                        <Button size="icon-sm" variant="ghost">
                          <Settings className="size-3.5" />
                        </Button>
                        <Button size="icon-xs" variant="ghost">
                          <X className="size-3" />
                        </Button>
                      </div>
                    </div>
                    {/* With Icons */}
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
                          <Plus className="size-4" /> Create
                        </Button>
                        <Button variant="secondary">
                          <Search className="size-4" /> Search
                        </Button>
                        <Button variant="destructive">
                          <Trash2 className="size-4" /> Delete
                        </Button>
                        <Button variant="inverse">
                          <ArrowRight className="size-4" /> Launch
                        </Button>
                        <Button variant="success" size="toolbar">
                          <Check className="size-3.5" /> Confirm
                        </Button>
                      </div>
                    </div>
                    {/* States */}
                    <div>
                      <p className="text-muted-foreground mb-3 text-xs tracking-wider uppercase">
                        States
                      </p>
                      <div className="flex flex-wrap items-center gap-2">
                        <Button disabled>Disabled</Button>
                        <Button disabled variant="outline">
                          {tHardcodedUi.raw(
                            'appHomeDesignSystemPage.line1096JsxTextDisabledOutline',
                          )}
                        </Button>
                        <Button>
                          <Loader2 className="size-4 animate-spin" /> Loading
                        </Button>
                      </div>
                    </div>
                  </div>
                </DemoContainer>
              </div>

              {/* ─── Badge ─── */}
              <div id="comp-badge" className="mb-12">
                <ComponentLabel>Badge</ComponentLabel>
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
                        <Badge variant="default">Default</Badge>
                        <Badge variant="secondary">Secondary</Badge>
                        <Badge variant="destructive">Destructive</Badge>
                        <Badge variant="outline">Outline</Badge>
                        <Badge variant="new">New</Badge>
                        <Badge variant="beta">Beta</Badge>
                        <Badge variant="highlight">Highlight</Badge>
                      </div>
                    </div>
                    <div>
                      <p className="text-muted-foreground mb-3 text-xs tracking-wider uppercase">
                        {tHardcodedUi.raw('appHomeDesignSystemPage.line1126JsxTextSemanticStatus')}
                      </p>
                      <div className="flex flex-wrap gap-2">
                        <Badge variant="success">Success</Badge>
                        <Badge variant="warning">Warning</Badge>
                        <Badge variant="info">Info</Badge>
                        <Badge variant="muted">Muted</Badge>
                      </div>
                    </div>
                    <div>
                      <p className="text-muted-foreground mb-3 text-xs tracking-wider uppercase">
                        Sizes
                      </p>
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="default">Default</Badge>
                        <Badge variant="default" size="sm">
                          Small
                        </Badge>
                        <Badge variant="success" size="sm">
                          Active
                        </Badge>
                        <Badge variant="warning" size="sm">
                          Pending
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
                          Featured
                        </Badge>
                        <Badge variant="success">
                          <Check className="size-3" />
                          Verified
                        </Badge>
                        <Badge variant="info">
                          <Info className="size-3" />
                          v2.1.0
                        </Badge>
                        <Badge variant="warning">
                          <AlertTriangle className="size-3" />
                          Pending
                        </Badge>
                      </div>
                    </div>
                  </div>
                </DemoContainer>
              </div>

              {/* ─── Card ─── */}
              <div id="comp-card" className="mb-12">
                <ComponentLabel>Card</ComponentLabel>
                <ComponentDesc>
                  {tHardcodedUi.raw(
                    'appHomeDesignSystemPage.line1160JsxTextContainerWithHeaderContentAndFooterSlotsDefault',
                  )}
                </ComponentDesc>
                <DemoContainer>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Card variant="default">
                      <CardHeader>
                        <CardTitle>
                          {tHardcodedUi.raw('appHomeDesignSystemPage.line1167JsxTextDefaultCard')}
                        </CardTitle>
                        <CardDescription>
                          {tHardcodedUi.raw(
                            'appHomeDesignSystemPage.line1169JsxTextStandardCardWithSolidBackground',
                          )}
                        </CardDescription>
                      </CardHeader>
                      <CardContent>
                        <p className="text-muted-foreground text-sm">
                          {tHardcodedUi.raw(
                            'appHomeDesignSystemPage.line1174JsxTextCardContentGoesHereUseForGroupingRelated',
                          )}
                        </p>
                      </CardContent>
                      <CardFooter>
                        <Button variant="outline" size="sm">
                          Action
                        </Button>
                      </CardFooter>
                    </Card>
                    <Card variant="glass">
                      <CardHeader>
                        <CardTitle>
                          {tHardcodedUi.raw('appHomeDesignSystemPage.line1186JsxTextGlassCard')}
                        </CardTitle>
                        <CardDescription>
                          {tHardcodedUi.raw(
                            'appHomeDesignSystemPage.line1188JsxTextTranslucentSurfaceForOverlaysAndPanels',
                          )}
                        </CardDescription>
                      </CardHeader>
                      <CardContent>
                        <p className="text-muted-foreground text-sm">
                          {tHardcodedUi.raw(
                            'appHomeDesignSystemPage.line1193JsxTextCardContentGoesHereUsedForOverlaysAnd',
                          )}
                        </p>
                      </CardContent>
                      <CardFooter>
                        <Button variant="outline" size="sm">
                          Action
                        </Button>
                      </CardFooter>
                    </Card>
                  </div>
                </DemoContainer>
              </div>

              {/* ─── Input ─── */}
              <div id="comp-input" className="mb-12">
                <ComponentLabel>Input</ComponentLabel>
                <ComponentDesc>
                  {tHardcodedUi.raw(
                    'appHomeDesignSystemPage.line1211JsxTextTextInputForFormsAndSearchTheCanonical',
                  )}
                </ComponentDesc>
                <DemoContainer>
                  <div className="max-w-sm space-y-4">
                    <div className="space-y-2">
                      <Label htmlFor="demo-input">Label</Label>
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
                    <Input type="text" disabled placeholder="Disabled" />
                  </div>
                </DemoContainer>
              </div>

              {/* ─── Textarea ─── */}
              <div id="comp-textarea" className="mb-12">
                <ComponentLabel>Textarea</ComponentLabel>
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

              {/* ─── Select ─── */}
              <div id="comp-select" className="mb-12">
                <ComponentLabel>Select</ComponentLabel>
                <ComponentDesc>
                  {tHardcodedUi.raw(
                    'appHomeDesignSystemPage.line1251JsxTextDropdownSelectionFromAListOfOptionsMatches',
                  )}
                </ComponentDesc>
                <DemoContainer>
                  <div className="max-w-xs">
                    <Select>
                      <SelectTrigger>
                        <SelectValue
                          placeholder={tHardcodedUi.raw(
                            'appHomeDesignSystemPage.line1259JsxAttrPlaceholderSelectAFramework',
                          )}
                        />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="next">Next.js</SelectItem>
                        <SelectItem value="remix">Remix</SelectItem>
                        <SelectItem value="astro">Astro</SelectItem>
                        <SelectItem value="nuxt">Nuxt</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </DemoContainer>
              </div>

              {/* ─── Checkbox ─── */}
              <div id="comp-checkbox" className="mb-12">
                <ComponentLabel>Checkbox</ComponentLabel>
                <ComponentDesc>
                  {tHardcodedUi.raw(
                    'appHomeDesignSystemPage.line1276JsxTextToggleForBooleanValues',
                  )}
                </ComponentDesc>
                <DemoContainer>
                  <div className="space-y-4">
                    <div className="flex items-center gap-2">
                      <Checkbox
                        id="check-1"
                        checked={checkboxChecked}
                        onCheckedChange={(v) => setCheckboxChecked(v as boolean)}
                      />
                      <Label htmlFor="check-1">Checked</Label>
                    </div>
                    <div className="flex items-center gap-2">
                      <Checkbox id="check-2" />
                      <Label htmlFor="check-2">Unchecked</Label>
                    </div>
                    <div className="flex items-center gap-2">
                      <Checkbox id="check-3" disabled />
                      <Label htmlFor="check-3" className="text-muted-foreground">
                        Disabled
                      </Label>
                    </div>
                  </div>
                </DemoContainer>
              </div>

              {/* ─── Switch ─── */}
              <div id="comp-switch" className="mb-12">
                <ComponentLabel>Switch</ComponentLabel>
                <ComponentDesc>
                  {tHardcodedUi.raw(
                    'appHomeDesignSystemPage.line1311JsxTextToggleControlForOnOffStates',
                  )}
                </ComponentDesc>
                <DemoContainer>
                  <div className="space-y-4">
                    <div className="flex items-center gap-3">
                      <Switch id="switch-on" checked={switchOn} onCheckedChange={setSwitchOn} />
                      <Label htmlFor="switch-on">On</Label>
                    </div>
                    <div className="flex items-center gap-3">
                      <Switch id="switch-off" checked={switchOff} onCheckedChange={setSwitchOff} />
                      <Label htmlFor="switch-off">Off</Label>
                    </div>
                    <div className="flex items-center gap-3">
                      <Switch id="switch-dis" disabled />
                      <Label htmlFor="switch-dis" className="text-muted-foreground">
                        Disabled
                      </Label>
                    </div>
                  </div>
                </DemoContainer>
              </div>

              {/* ─── Toggle ─── */}
              <div id="comp-toggle" className="mb-12">
                <ComponentLabel>Toggle</ComponentLabel>
                <ComponentDesc>
                  {tHardcodedUi.raw(
                    'appHomeDesignSystemPage.line1348JsxTextATwoStateButtonWithDefaultAndOutline',
                  )}
                </ComponentDesc>
                <DemoContainer>
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
                </DemoContainer>
              </div>

              {/* ─── Radio Group ─── */}
              <div id="comp-radio" className="mb-12">
                <ComponentLabel>
                  {tHardcodedUi.raw('appHomeDesignSystemPage.line1369JsxTextRadioGroup')}
                </ComponentLabel>
                <ComponentDesc>
                  {tHardcodedUi.raw(
                    'appHomeDesignSystemPage.line1371JsxTextSingleSelectionFromASetOfOptions',
                  )}
                </ComponentDesc>
                <DemoContainer>
                  <RadioGroup defaultValue="comfortable">
                    <div className="flex items-center gap-2">
                      <RadioGroupItem value="default" id="r1" />
                      <Label htmlFor="r1">Default</Label>
                    </div>
                    <div className="flex items-center gap-2">
                      <RadioGroupItem value="comfortable" id="r2" />
                      <Label htmlFor="r2">Comfortable</Label>
                    </div>
                    <div className="flex items-center gap-2">
                      <RadioGroupItem value="compact" id="r3" />
                      <Label htmlFor="r3">Compact</Label>
                    </div>
                  </RadioGroup>
                </DemoContainer>
              </div>

              {/* ─── Tabs ─── */}
              <div id="comp-tabs" className="mb-12">
                <ComponentLabel>Tabs</ComponentLabel>
                <ComponentDesc>
                  {tHardcodedUi.raw(
                    'appHomeDesignSystemPage.line1395JsxTextTabbedNavigationWithStandardAndCompactVariants',
                  )}
                </ComponentDesc>
                <DemoContainer>
                  <div className="space-y-6">
                    <div>
                      <p className="text-muted-foreground mb-3 text-xs">Standard</p>
                      <Tabs defaultValue="tab1">
                        <TabsList>
                          <TabsTrigger value="tab1">Account</TabsTrigger>
                          <TabsTrigger value="tab2">Password</TabsTrigger>
                          <TabsTrigger value="tab3">Settings</TabsTrigger>
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
                      <p className="text-muted-foreground mb-3 text-xs">Compact</p>
                      <Tabs defaultValue="c1">
                        <TabsListCompact>
                          <TabsTriggerCompact value="c1">Day</TabsTriggerCompact>
                          <TabsTriggerCompact value="c2">Week</TabsTriggerCompact>
                          <TabsTriggerCompact value="c3">Month</TabsTriggerCompact>
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

              {/* ─── Dialog ─── */}
              <div id="comp-dialog" className="mb-12">
                <ComponentLabel>Dialog</ComponentLabel>
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
                        <Button variant="outline">Cancel</Button>
                        <Button>Confirm</Button>
                      </DialogFooter>
                    </DialogContent>
                  </Dialog>
                </DemoContainer>
              </div>

              {/* ─── Modal ─── */}
              <div id="comp-modal" className="mb-12">
                <ComponentLabel>Modal</ComponentLabel>
                <ComponentDesc>
                  Responsive overlay: bottom sheet on mobile, centered dialog on desktop. Supports
                  side variants via <code className="font-mono text-xs">side</code>.
                </ComponentDesc>
                <DemoContainer>
                  <Modal>
                    <ModalTrigger asChild>
                      <Button variant="outline">Open Modal</Button>
                    </ModalTrigger>
                    <ModalContent>
                      <ModalHeader>
                        <ModalTitle>Modal Title</ModalTitle>
                        <ModalDescription>
                          This is a description of the modal content.
                        </ModalDescription>
                      </ModalHeader>
                      <ModalBody>
                        <p className="text-muted-foreground text-sm">
                          Modal body content goes here.
                        </p>
                      </ModalBody>
                      <ModalFooter>
                        <Button variant="outline">Cancel</Button>
                        <Button>Confirm</Button>
                      </ModalFooter>
                    </ModalContent>
                  </Modal>
                </DemoContainer>
              </div>

              {/* ─── Sheet ─── */}
              <div id="comp-sheet" className="mb-12">
                <ComponentLabel>Sheet</ComponentLabel>
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

              {/* ─── Dropdown Menu ─── */}
              <div id="comp-dropdown" className="mb-12">
                <ComponentLabel>
                  {tHardcodedUi.raw('appHomeDesignSystemPage.line1526JsxTextDropdownMenu')}
                </ComponentLabel>
                <ComponentDesc>
                  {tHardcodedUi.raw(
                    'appHomeDesignSystemPage.line1528JsxTextContextualMenuTriggeredByAButtonRowsStay',
                  )}{' '}
                  <strong>neutral</strong>
                  {tHardcodedUi.raw(
                    'appHomeDesignSystemPage.line1529JsxTextEvenDestructiveOnesLikeDeleteOrRemoveRed',
                  )}
                </ComponentDesc>
                <DemoContainer>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="outline">
                        <MoreHorizontal className="size-4" />
                        Options
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent>
                      <DropdownMenuLabel>Actions</DropdownMenuLabel>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem>Edit</DropdownMenuItem>
                      <DropdownMenuItem>Duplicate</DropdownMenuItem>
                      <DropdownMenuItem>Archive</DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem variant="destructive">Delete</DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </DemoContainer>
              </div>

              {/* ─── Tooltip ─── */}
              <div id="comp-tooltip" className="mb-12">
                <ComponentLabel>Tooltip</ComponentLabel>
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
                          <p>Settings</p>
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

              {/* ─── Popover ─── */}
              <div id="comp-popover" className="mb-12">
                <ComponentLabel>Popover</ComponentLabel>
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
                          {tHardcodedUi.raw('appHomeDesignSystemPage.line1607JsxTextPopoverTitle')}
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

              {/* ─── Alert ─── */}
              <div id="comp-alert" className="mb-12">
                <ComponentLabel>Alert</ComponentLabel>
                <ComponentDesc>
                  {tHardcodedUi.raw(
                    'appHomeDesignSystemPage.line1622JsxTextInlineNotificationWithContextualVariants',
                  )}
                </ComponentDesc>
                <DemoContainer>
                  <div className="space-y-3">
                    <Alert>
                      <Info className="size-4" />
                      <AlertTitle>
                        {tHardcodedUi.raw('appHomeDesignSystemPage.line1628JsxTextDefaultAlert')}
                      </AlertTitle>
                      <AlertDescription>
                        {tHardcodedUi.raw(
                          'appHomeDesignSystemPage.line1630JsxTextThisIsADefaultInformationalAlert',
                        )}
                      </AlertDescription>
                    </Alert>
                    <Alert variant="destructive">
                      <AlertCircle className="size-4" />
                      <AlertTitle>Destructive</AlertTitle>
                      <AlertDescription>
                        {tHardcodedUi.raw(
                          'appHomeDesignSystemPage.line1637JsxTextSomethingWentWrongPleaseTryAgain',
                        )}
                      </AlertDescription>
                    </Alert>
                    <Alert variant="warning">
                      <TriangleAlert className="size-4" />
                      <AlertTitle>Warning</AlertTitle>
                      <AlertDescription>
                        {tHardcodedUi.raw(
                          'appHomeDesignSystemPage.line1644JsxTextThisActionMayHaveUnintendedConsequences',
                        )}
                      </AlertDescription>
                    </Alert>
                  </div>
                </DemoContainer>
              </div>

              {/* ─── Alert Dialog ─── */}
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
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction>Delete</AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </DemoContainer>
              </div>

              {/* ─── Accordion ─── */}
              <div id="comp-accordion" className="mb-12">
                <ComponentLabel>Accordion</ComponentLabel>
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
                        {tHardcodedUi.raw('appHomeDesignSystemPage.line1712JsxTextHowDoThemesWork')}
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

              {/* ─── Collapsible ─── */}
              <div id="comp-collapsible" className="mb-12">
                <ComponentLabel>Collapsible</ComponentLabel>
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
                          <span className="sr-only">Toggle</span>
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

              {/* ─── Separator ─── */}
              <div id="comp-separator" className="mb-12">
                <ComponentLabel>Separator</ComponentLabel>
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

              {/* ─── Skeleton ─── */}
              <div id="comp-skeleton" className="mb-12">
                <ComponentLabel>Skeleton</ComponentLabel>
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
                        {tHardcodedUi.raw('appHomeDesignSystemPage.line1809JsxTextInlineVariants')}
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

              {/* ─── Progress ─── */}
              <div id="comp-progress" className="mb-12">
                <ComponentLabel>Progress</ComponentLabel>
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

              {/* ─── Slider ─── */}
              <div id="comp-slider" className="mb-12">
                <ComponentLabel>Slider</ComponentLabel>
                <ComponentDesc>
                  {tHardcodedUi.raw(
                    'appHomeDesignSystemPage.line1848JsxTextRangeInputForSelectingNumericValues',
                  )}
                </ComponentDesc>
                <DemoContainer>
                  <div className="max-w-sm space-y-4">
                    <Slider value={sliderValue} onValueChange={setSliderValue} max={100} step={1} />
                    <span className="text-muted-foreground font-mono text-xs">
                      Value: {sliderValue[0]}
                    </span>
                  </div>
                </DemoContainer>
              </div>

              {/* ─── Label ─── */}
              <div id="comp-label" className="mb-12">
                <ComponentLabel>Label</ComponentLabel>
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

              {/* ─── Breadcrumb ─── */}
              <div id="comp-breadcrumb" className="mb-12">
                <ComponentLabel>Breadcrumb</ComponentLabel>
                <ComponentDesc>
                  {tHardcodedUi.raw(
                    'appHomeDesignSystemPage.line1887JsxTextNavigationHierarchyTrail',
                  )}
                </ComponentDesc>
                <DemoContainer>
                  <Breadcrumb>
                    <BreadcrumbList>
                      <BreadcrumbItem>
                        <BreadcrumbLink href="#">Home</BreadcrumbLink>
                      </BreadcrumbItem>
                      <BreadcrumbSeparator />
                      <BreadcrumbItem>
                        <BreadcrumbLink href="#">Workspace</BreadcrumbLink>
                      </BreadcrumbItem>
                      <BreadcrumbSeparator />
                      <BreadcrumbItem>
                        <BreadcrumbPage>
                          {tHardcodedUi.raw('appHomeDesignSystemPage.line1901JsxTextDesignSystem')}
                        </BreadcrumbPage>
                      </BreadcrumbItem>
                    </BreadcrumbList>
                  </Breadcrumb>
                </DemoContainer>
              </div>

              {/* ─── Table ─── */}
              <div id="comp-table" className="mb-12">
                <ComponentLabel>Table</ComponentLabel>
                <ComponentDesc>
                  {tHardcodedUi.raw(
                    'appHomeDesignSystemPage.line1912JsxTextStructuredDataDisplayInRowsAndColumns',
                  )}
                </ComponentDesc>
                <DemoContainer className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Component</TableHead>
                        <TableHead>Variants</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead className="text-right">Instances</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      <TableRow>
                        <TableCell className="font-medium">Button</TableCell>
                        <TableCell>6</TableCell>
                        <TableCell>
                          <Badge variant="new" className="text-xs">
                            Stable
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right">624</TableCell>
                      </TableRow>
                      <TableRow>
                        <TableCell className="font-medium">Badge</TableCell>
                        <TableCell>7</TableCell>
                        <TableCell>
                          <Badge variant="new" className="text-xs">
                            Stable
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right">189</TableCell>
                      </TableRow>
                      <TableRow>
                        <TableCell className="font-medium">Card</TableCell>
                        <TableCell>2</TableCell>
                        <TableCell>
                          <Badge variant="new" className="text-xs">
                            Stable
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right">312</TableCell>
                      </TableRow>
                      <TableRow>
                        <TableCell className="font-medium">Input</TableCell>
                        <TableCell>1</TableCell>
                        <TableCell>
                          <Badge variant="beta" className="text-xs">
                            Enhancing
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right">247</TableCell>
                      </TableRow>
                    </TableBody>
                  </Table>
                </DemoContainer>
              </div>

              {/* ─── Kbd ─── */}
              <div id="comp-kbd" className="mb-12">
                <ComponentLabel>Kbd</ComponentLabel>
                <ComponentDesc>
                  {tHardcodedUi.raw(
                    'appHomeDesignSystemPage.line1968JsxTextKeyboardShortcutIndicatorsThemeAwareIncludingAutomaticStyling',
                  )}
                </ComponentDesc>
                <DemoContainer>
                  <div className="space-y-4">
                    <div>
                      <p className="text-muted-foreground mb-3 text-xs">
                        {tHardcodedUi.raw('appHomeDesignSystemPage.line1975JsxTextIndividualKeys')}
                      </p>
                      <div className="flex flex-wrap items-center gap-2">
                        <Kbd>⌘</Kbd>
                        <Kbd>K</Kbd>
                        <Kbd>Shift</Kbd>
                        <Kbd>Enter</Kbd>
                        <Kbd>Esc</Kbd>
                        <Kbd>Tab</Kbd>
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
                          <Kbd>Shift</Kbd>
                          <span className="text-muted-foreground text-xs">+</span>
                          <Kbd>P</Kbd>
                        </KbdGroup>
                        <KbdGroup>
                          <Kbd>Ctrl</Kbd>
                          <span className="text-muted-foreground text-xs">+</span>
                          <Kbd>C</Kbd>
                        </KbdGroup>
                      </div>
                    </div>
                  </div>
                </DemoContainer>
              </div>

              {/* ─── Calendar ─── */}
              <div id="comp-calendar" className="mb-12">
                <ComponentLabel>Calendar</ComponentLabel>
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

              {/* ─── Scroll Area ─── */}
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
            </section>

            {/* ═══════════════ Page Patterns ═══════════════ */}
            <section id="page-patterns">
              <SectionDivider />
              <h2 className="text-muted-foreground mb-5 text-xs tracking-widest uppercase">
                {tHardcodedUi.raw('appHomeDesignSystemPage.line2070JsxTextPagePatterns')}
              </h2>
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

              {/* ── PageHeader ── */}
              <div id="pat-page-header" className="mb-12">
                <ComponentLabel>PageHeader</ComponentLabel>
                <ComponentDesc>
                  {tHardcodedUi.raw(
                    'appHomeDesignSystemPage.line2084JsxTextTheCanonicalHeroForListManagementPagesRounded',
                  )}
                  <code className="font-mono text-xs">max-w-7xl</code>
                  {tHardcodedUi.raw('appHomeDesignSystemPage.line2087JsxTextHorizontalPadding')}
                </ComponentDesc>
                <DemoContainer className="overflow-hidden p-0">
                  <div className="p-6">
                    <PageHeader icon={Zap}>
                      <div className="space-y-2 sm:space-y-4">
                        <div className="text-2xl font-semibold tracking-tight sm:text-3xl md:text-4xl">
                          <span className="text-primary">
                            {tHardcodedUi.raw(
                              'appHomeDesignSystemPage.line2094JsxTextScheduledTasks',
                            )}
                          </span>
                        </div>
                      </div>
                    </PageHeader>
                  </div>
                </DemoContainer>
                <pre className="text-muted-foreground bg-muted/20 mt-3 overflow-x-auto rounded-lg px-4 py-3 font-mono text-xs">{`<div className="container mx-auto max-w-7xl px-3 sm:px-4 py-3 sm:py-4">
  <PageHeader icon={Zap}>
    <div className="text-2xl sm:text-3xl md:text-4xl font-semibold tracking-tight">
      <span className="text-primary">Scheduled Tasks</span>
    </div>
  </PageHeader>
</div>`}</pre>
              </div>

              {/* ── SpotlightCard ── */}
              <div id="pat-spotlight-card" className="mb-12">
                <ComponentLabel>SpotlightCard</ComponentLabel>
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
                      { icon: Cable, label: 'tunnel-42', sub: 'exposes :3000' },
                      { icon: Radio, label: '#releases', sub: 'Slack channel' },
                      {
                        icon: Zap,
                        label: 'nightly-cron',
                        sub: 'every day at 03:00',
                      },
                      { icon: Plug, label: 'GitHub', sub: 'Connected' },
                    ].map((item, i) => {
                      const I = item.icon;
                      return (
                        <SpotlightCard key={i} className="bg-card border-border/50 border">
                          <div className="flex cursor-pointer items-center gap-3 p-4">
                            <div className="bg-muted border-border/50 flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] border">
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
                <ComponentLabel>PageSearchBar</ComponentLabel>
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
                      New
                    </Button>
                  </div>
                </DemoContainer>
              </div>

              {/* ── Stagger Mount ── */}
              <div id="pat-stagger" className="mb-12">
                <ComponentLabel>
                  {tHardcodedUi.raw('appHomeDesignSystemPage.line2179JsxTextStaggerMount')}
                </ComponentLabel>
                <ComponentDesc>
                  {tHardcodedUi.raw(
                    'appHomeDesignSystemPage.line2181JsxTextEveryManagementPageMountsItsThreeZonesWith',
                  )}
                  <code className="font-mono text-xs">delay-75</code>
                  {tHardcodedUi.raw('appHomeDesignSystemPage.line2183JsxTextContentAt')}
                  <code className="font-mono text-xs">delay-150</code>.
                </ComponentDesc>
                <DemoContainer>
                  <pre className="text-muted-foreground bg-muted/20 overflow-x-auto rounded-lg px-4 py-3 font-mono text-xs leading-relaxed">{`// Page header
<div className="... animate-in fade-in-0 slide-in-from-bottom-4 duration-500 fill-mode-both">

// Search + action bar
<div className="... animate-in fade-in-0 slide-in-from-bottom-4 duration-500 fill-mode-both delay-75">

// Content area
<div className="... animate-in fade-in-0 slide-in-from-bottom-4 duration-500 fill-mode-both delay-150">`}</pre>
                </DemoContainer>
              </div>
            </section>

            {/* ═══════════════ Primitives ═══════════════ */}
            <section id="patterns">
              <SectionDivider />
              <h2 className="text-muted-foreground mb-5 text-xs tracking-widest uppercase">
                Primitives
              </h2>
              <p className="text-muted-foreground mb-8 text-base leading-relaxed">
                {tHardcodedUi.raw(
                  'appHomeDesignSystemPage.line2205JsxTextSmallCompositionPiecesUsedInsideProjectPagesIssue',
                )}
              </p>

              {/* ── PageShell ── */}
              <div id="pat-page-shell" className="mb-12">
                <ComponentLabel>PageShell</ComponentLabel>
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
                <ComponentLabel>Section</ComponentLabel>
                <ComponentDesc>
                  {tHardcodedUi.raw(
                    'appHomeDesignSystemPage.line2233JsxTextLabelledSectionInsideAPageshellUppercaseMicroLabel',
                  )}
                </ComponentDesc>
                <DemoContainer>
                  <BrandSection label="About">
                    <p className="text-foreground text-sm leading-relaxed">
                      {tHardcodedUi.raw(
                        'appHomeDesignSystemPage.line2241JsxTextDescriptionContentLivesHereSectionsSeparateConcernsOn',
                      )}
                    </p>
                  </BrandSection>
                  <BrandSection
                    label="Details"
                    action={
                      <Button variant="ghost" size="sm" className="h-6 px-2 text-xs">
                        Edit
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

              {/* ── SectionCard ── */}
              <div id="pat-section-card" className="mb-12">
                <ComponentLabel>SectionCard</ComponentLabel>
                <ComponentDesc>
                  {tHardcodedUi.raw(
                    'appHomeDesignSystemPage.line2264JsxTextTheOnePanelPatternComposesTheDesignSystem',
                  )}
                  <code>flush</code>
                  {tHardcodedUi.raw(
                    'appHomeDesignSystemPage.line2267JsxTextToSeatAListEdgeToEdgeAnd',
                  )}{' '}
                  <code>
                    {tHardcodedUi.raw(
                      'appHomeDesignSystemPage.line2268JsxTextToneQuotDestructiveQuot',
                    )}
                  </code>
                  {tHardcodedUi.raw(
                    'appHomeDesignSystemPage.line2268JsxTextForDangerZonesNoSeparateComponentADanger',
                  )}
                  <strong>neutral</strong>
                  {tHardcodedUi.raw(
                    'appHomeDesignSystemPage.line2270JsxTextTriggerRedIsTheBrakeNotThePaint',
                  )}
                </ComponentDesc>
                <DemoContainer className="space-y-4">
                  <SectionCard
                    title="Members"
                    count={2}
                    description={tHardcodedUi.raw(
                      'appHomeDesignSystemPage.line2278JsxAttrDescriptionPeopleWithAccessToThisAccount',
                    )}
                    action={
                      <Button size="sm" className="h-8 px-3 text-sm">
                        Invite
                      </Button>
                    }
                  >
                    <p className="text-muted-foreground text-sm">
                      {tHardcodedUi.raw(
                        'appHomeDesignSystemPage.line2286JsxTextBodyContentSitsInThePaddedRegionPass',
                      )}{' '}
                      <code>flush</code>
                      {tHardcodedUi.raw(
                        'appHomeDesignSystemPage.line2287JsxTextToDropThePaddingForAList',
                      )}
                    </p>
                  </SectionCard>
                  <SectionCard
                    tone="destructive"
                    title={tHardcodedUi.raw(
                      'appHomeDesignSystemPage.line2292JsxAttrTitleDangerZone',
                    )}
                    description={tHardcodedUi.raw(
                      'appHomeDesignSystemPage.line2293JsxAttrDescriptionIrreversibleActionsLiveHere',
                    )}
                  >
                    <div className="flex items-center justify-between gap-4">
                      <div className="min-w-0">
                        <p className="text-foreground text-sm font-medium">
                          {tHardcodedUi.raw(
                            'appHomeDesignSystemPage.line2298JsxTextDeleteThisAccount',
                          )}
                        </p>
                        <p className="text-muted-foreground mt-0.5 text-xs">
                          {tHardcodedUi.raw(
                            'appHomeDesignSystemPage.line2301JsxTextPermanentlyRemovesTheAccountAndAllItsData',
                          )}
                        </p>
                      </div>
                      <Button variant="outline" size="sm" className="shrink-0">
                        Delete
                      </Button>
                    </div>
                  </SectionCard>
                </DemoContainer>
              </div>

              {/* ── Avatars ── */}
              <div id="pat-avatars" className="mb-12">
                <ComponentLabel>Avatars</ComponentLabel>
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
                  {tHardcodedUi.raw('appHomeDesignSystemPage.line2319JsxTextNoColouredBackgrounds')}
                  <code>EntityAvatar</code>
                  {tHardcodedUi.raw(
                    'appHomeDesignSystemPage.line2320JsxTextRendersARoundedSquareTileForAccountsProjects',
                  )}
                </ComponentDesc>
                <DemoContainer className="space-y-5">
                  <div className="flex items-center gap-4">
                    <span className="text-muted-foreground w-24 text-xs tracking-wider uppercase">
                      People
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
                      Things
                    </span>
                    <EntityAvatar
                      label={tHardcodedUi.raw(
                        'appHomeDesignSystemPage.line2338JsxAttrLabelAcmeAgi',
                      )}
                      size="sm"
                    />
                    <EntityAvatar label="Kortix" />
                    <EntityAvatar icon={FolderGit2} />
                    <EntityAvatar icon={Users} size="lg" />
                  </div>
                </DemoContainer>
              </div>

              {/* ── List & ListRow ── */}
              <div id="pat-list" className="mb-12">
                <ComponentLabel>
                  {tHardcodedUi.raw('appHomeDesignSystemPage.line2348JsxTextListAmpListrow')}
                </ComponentLabel>
                <ComponentDesc>
                  {tHardcodedUi.raw(
                    'appHomeDesignSystemPage.line2350JsxTextTheStandardListADividerSeparated',
                  )}
                  <code>List</code> of <code>ListRow</code>
                  {tHardcodedUi.raw(
                    'appHomeDesignSystemPage.line2351JsxTextSEachWithALeadingAvatarSlotUseravatar',
                  )}{' '}
                  <code>
                    {tHardcodedUi.raw('appHomeDesignSystemPage.line2355JsxTextSectioncardFlush')}
                  </code>
                  .
                </ComponentDesc>
                <DemoContainer className="p-0">
                  <SectionCard title="Members" count={2} flush>
                    <List>
                      <ListRow
                        leading={
                          <UserAvatar
                            email={tHardcodedUi.raw(
                              'appHomeDesignSystemPage.line2361JsxAttrEmailGraceKortixAi',
                            )}
                            name="Grace Hopper"
                          />
                        }
                        title={tHardcodedUi.raw(
                          'appHomeDesignSystemPage.line2362JsxAttrTitleGraceKortixAi',
                        )}
                        badges={
                          <Badge variant="outline" size="sm">
                            You
                          </Badge>
                        }
                        subtitle={
                          <InlineMeta>
                            <span>
                              {tHardcodedUi.raw(
                                'appHomeDesignSystemPage.line2370JsxTextJoinedMar32026',
                              )}
                            </span>
                            <span>
                              {tHardcodedUi.raw(
                                'appHomeDesignSystemPage.line2371JsxTextText4Projects',
                              )}
                            </span>
                          </InlineMeta>
                        }
                        trailing={
                          <Badge
                            variant="outline"
                            size="sm"
                            className="border-foreground/30 text-foreground"
                          >
                            Owner
                          </Badge>
                        }
                      />
                      <ListRow
                        leading={
                          <UserAvatar
                            email={tHardcodedUi.raw(
                              'appHomeDesignSystemPage.line2381JsxAttrEmailAlanKortixAi',
                            )}
                            name="Alan Turing"
                          />
                        }
                        title={tHardcodedUi.raw(
                          'appHomeDesignSystemPage.line2382JsxAttrTitleAlanKortixAi',
                        )}
                        subtitle={
                          <InlineMeta>
                            <span>
                              {tHardcodedUi.raw(
                                'appHomeDesignSystemPage.line2385JsxTextJoinedApr12026',
                              )}
                            </span>
                          </InlineMeta>
                        }
                        trailing={
                          <Badge variant="outline" size="sm">
                            Member
                          </Badge>
                        }
                      />
                    </List>
                  </SectionCard>
                </DemoContainer>
              </div>

              {/* ── DefinitionList ── */}
              <div id="pat-definition-list" className="mb-12">
                <ComponentLabel>DefinitionList</ComponentLabel>
                <ComponentDesc>
                  {tHardcodedUi.raw(
                    'appHomeDesignSystemPage.line2403JsxTextKeyValuePairsFixedWidthLabelColumnSo',
                  )}
                </ComponentDesc>
                <DemoContainer>
                  <DefinitionList dividers>
                    <DefinitionRow label="Path">
                      <code className="text-foreground font-mono text-xs">
                        /workspace/jjk-domain-search
                      </code>
                    </DefinitionRow>
                    <DefinitionRow label="Created">
                      {tHardcodedUi.raw('appHomeDesignSystemPage.line2413JsxTextText2DaysAgo')}
                    </DefinitionRow>
                    <DefinitionRow label="Updated">
                      <span className="tabular-nums">
                        {tHardcodedUi.raw('appHomeDesignSystemPage.line2415JsxTextText3mAgo')}
                      </span>
                    </DefinitionRow>
                    <DefinitionRow label="Sessions">8</DefinitionRow>
                  </DefinitionList>
                </DemoContainer>
              </div>

              {/* ── InlineMeta ── */}
              <div id="pat-inline-meta" className="mb-12">
                <ComponentLabel>InlineMeta</ComponentLabel>
                <ComponentDesc>
                  {tHardcodedUi.raw(
                    'appHomeDesignSystemPage.line2426JsxTextDotSeparatedFactsDropAnyNumberOfChildren',
                  )}
                </ComponentDesc>
                <DemoContainer>
                  <InlineMeta>
                    <span className="text-foreground font-mono">/workspace/jjk</span>
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
                <ComponentLabel>EmptyState</ComponentLabel>
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
                <ComponentLabel>InfoBanner</ComponentLabel>
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
                    title={tHardcodedUi.raw('appHomeDesignSystemPage.line2479JsxAttrTitleHeadsUp')}
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
                        Dismiss
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
                  <code>text-emerald-500</code>.
                </ComponentDesc>
                <DemoContainer className="flex flex-col gap-4">
                  <div className="flex items-center gap-4 text-sm">
                    <span className="inline-flex items-center gap-1.5">
                      <StatusDot tone="success" /> Idle
                    </span>
                    <span className="inline-flex items-center gap-1.5">
                      <StatusDot tone="success" pulse /> Running
                    </span>
                    <span className="inline-flex items-center gap-1.5">
                      <StatusDot tone="warning" /> Warning
                    </span>
                    <span className="inline-flex items-center gap-1.5">
                      <StatusDot tone="destructive" /> Error
                    </span>
                    <span className="inline-flex items-center gap-1.5">
                      <StatusDot tone="info" /> Info
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
                    <StatusBadge tone="info">Modified</StatusBadge>
                    <StatusBadge tone="neutral">Idle</StatusBadge>
                  </div>
                  <p className="text-muted-foreground text-xs">
                    Use <code>StatusBadge</code>
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
            </section>

            {/* ═══════════════ Anti-Patterns ═══════════════ */}
            <section id="anti-patterns">
              <SectionDivider />
              <h2 className="text-muted-foreground mb-5 text-xs tracking-widest uppercase">
                Anti-Patterns
              </h2>
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
                  bad={`<div style={{ height: '14px', overflow: 'hidden' }}>\n  Content\n</div>`}
                  good={`<div className="h-3.5 overflow-hidden">\n  Content\n</div>`}
                />

                <AntiPatternBlock
                  title={tHardcodedUi.raw(
                    'appHomeDesignSystemPage.line2571JsxAttrTitleAp2NoArbitraryTextSizes',
                  )}
                  description={tHardcodedUi.raw(
                    'appHomeDesignSystemPage.line2572JsxAttrDescriptionCreatesInconsistentTypeSizesWithNoSemanticMeaning',
                  )}
                  bad={
                    '<span className="text-' +
                    '[11px]">Label</span>\n<span className="text-' +
                    '[13.5px]">Meta</span>\n<span className="text-' +
                    '[0.875em]">Body</span>'
                  }
                  good={`<span className="text-xs">Label</span>\n<span className="text-xs">Meta</span>\n<span className="text-sm">Body</span>`}
                />

                <AntiPatternBlock
                  title={tHardcodedUi.raw(
                    'appHomeDesignSystemPage.line2583JsxAttrTitleAp3NoRawButtonElements',
                  )}
                  description={tHardcodedUi.raw(
                    'appHomeDesignSystemPage.line2584JsxAttrDescriptionRawButtonsBypassVariantSystemHaveInconsistentSizing',
                  )}
                  bad={`<button\n  className="px-3 py-1.5 rounded-lg\n    bg-neutral-100 hover:bg-neutral-200"\n  onClick={handleClick}\n>\n  Save\n</button>`}
                  good={`<Button\n  variant="secondary"\n  size="sm"\n  onClick={handleClick}\n>\n  Save\n</Button>`}
                />

                <AntiPatternBlock
                  title={tHardcodedUi.raw(
                    'appHomeDesignSystemPage.line2590JsxAttrTitleAp4NoTransitionColors',
                  )}
                  description={tHardcodedUi.raw(
                    'appHomeDesignSystemPage.line2591JsxAttrDescriptionAnimatesEveryCssPropertyIncludingWidthHeightPadding',
                  )}
                  bad={`<div className="transition-colors duration-200\n  hover:bg-accent">`}
                  good={`<div className="transition-colors\n  duration-moderate hover:bg-accent">`}
                />

                <AntiPatternBlock
                  title={tHardcodedUi.raw(
                    'appHomeDesignSystemPage.line2597JsxAttrTitleAp5NoHardcodedHexColors',
                  )}
                  description={tHardcodedUi.raw(
                    'appHomeDesignSystemPage.line2598JsxAttrDescriptionCompletelyBypassesTheThemeSystemWillLookWrong',
                  )}
                  bad={`<div className="text-emerald-500">\n  Success\n</div>\n<div style={{ color: '#3b82f6' }}>\n  Info\n</div>`}
                  good={`<div className="text-success">\n  Success\n</div>\n<div className="text-info">\n  Info\n</div>`}
                />

                <AntiPatternBlock
                  title={tHardcodedUi.raw(
                    'appHomeDesignSystemPage.line2604JsxAttrTitleAp6NoClickableDivElements',
                  )}
                  description={tHardcodedUi.raw(
                    'appHomeDesignSystemPage.line2605JsxAttrDescriptionNotKeyboardAccessibleNoFocusRingNotAnnounced',
                  )}
                  bad={`<div\n  onClick={handler}\n  className="cursor-pointer"\n>\n  Click me\n</div>`}
                  good={`<Button\n  variant="ghost"\n  onClick={handler}\n>\n  Click me\n</Button>`}
                />
              </div>
            </section>

            {/* ═══════════════ Usage ═══════════════ */}
            <section id="usage">
              <SectionDivider />
              <h2 className="text-muted-foreground mb-5 text-xs tracking-widest uppercase">
                Usage
              </h2>

              <div className="grid gap-10 md:grid-cols-2">
                <div>
                  <p className="mb-4 text-xs tracking-widest text-emerald-600 uppercase dark:text-emerald-400">
                    Do
                  </p>
                  {[
                    'Use the logo on solid black or white backgrounds',
                    'Maintain minimum clear space on all sides',
                    'Use the provided SVG/PNG files',
                    'Black logo on light, white on dark',
                    'Scale proportionally',
                    'Use font-medium (500) for headings',
                    'Use semantic color tokens (success, warning, info)',
                    'Use the defined type scale tokens',
                    'Use specific transition properties',
                    'Use <Button> and <IconButton> components',
                  ].map((t) => (
                    <div
                      key={t}
                      className="border-border/30 flex items-start gap-2.5 border-b py-2"
                    >
                      <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                        <Check className="size-2.5" />
                      </span>
                      <span className="text-muted-foreground text-sm">{t}</span>
                    </div>
                  ))}
                </div>
                <div>
                  <p className="mb-4 text-xs tracking-widest text-red-600 uppercase dark:text-red-400">
                    Don{"'"}t
                  </p>
                  {[
                    'Rotate, skew, or stretch the logo',
                    'Add drop shadows or effects',
                    'Place on busy or patterned backgrounds',
                    'Use unapproved color combinations',
                    'Use bold (700) for headings',
                    'Use colored or tinted backgrounds',
                    'Use arbitrary pixel text sizes',
                    'Use transition-colors on elements',
                    'Use raw <button> for interactions',
                    'Use hardcoded hex colors in components',
                  ].map((t) => (
                    <div
                      key={t}
                      className="border-border/30 flex items-start gap-2.5 border-b py-2"
                    >
                      <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full bg-red-500/10 text-red-600 dark:text-red-400">
                        <X className="size-2.5" />
                      </span>
                      <span className="text-muted-foreground text-sm">{t}</span>
                    </div>
                  ))}
                </div>
              </div>
            </section>
          </div>
        </div>
      </div>
    </main>
  );
}
