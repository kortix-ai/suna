'use client';

import { useTranslations } from 'next-intl';

import { useState, useEffect } from 'react';
import {
  Download,
  Check,
  Copy,
  X,
  Loader2,
  AlertCircle,
  AlertTriangle,
  Info,
  TriangleAlert,
  Bold,
  Settings,
  MoreHorizontal,
  HelpCircle,
  ChevronsUpDown,
  Search,
  Plus,
  Trash2,
  ArrowRight,
  Mail,
  Star,
  FolderGit2,
  Users,
} from 'lucide-react';
import { cn } from '@/lib/utils';

import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { Switch } from '@/components/ui/switch';
import { Toggle } from '@/components/ui/toggle';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
  TabsListCompact,
  TabsTriggerCompact,
} from '@/components/ui/tabs';
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
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  TooltipProvider,
} from '@/components/ui/tooltip';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
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
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Progress } from '@/components/ui/progress';
import { Slider } from '@/components/ui/slider';
import { Label } from '@/components/ui/label';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Kbd, KbdGroup } from '@/components/ui/kbd';
import { Calendar } from '@/components/ui/calendar';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { PageShell } from '@/components/ui/page-shell';
import { Section as BrandSection } from '@/components/ui/section';
import {
  DefinitionList,
  DefinitionRow,
} from '@/components/ui/definition-list';
import { InlineMeta } from '@/components/ui/inline-meta';
import { EmptyState } from '@/components/ui/empty-state';
import { EntityAvatar } from '@/components/ui/entity-avatar';
import { InfoBanner } from '@/components/ui/info-banner';
import { StatusDot, DiffStat, StatusBadge } from '@/components/ui/status';
import { UserAvatar } from '@/components/ui/user-avatar';
import { List, ListRow } from '@/components/ui/list';
import { SectionCard } from '@/components/ui/section-card';
import { IconInbox } from '@/components/ui/kortix-icons';
import { PageHeader } from '@/components/ui/page-header';
import { SpotlightCard } from '@/components/ui/spotlight-card';
import { PageSearchBar } from '@/components/ui/page-search-bar';
import { Cable, Radio, Zap, Plug } from 'lucide-react';

/* ─────────────────────── Data ─────────────────────── */

const BRAND_COLORS = [
  { name: 'Black', hex: '#000000', oklch: 'oklch(0 0 0)', light: false },
  { name: 'Off-Black', hex: '#1A1A1A', oklch: 'oklch(0.145 0 0)', light: false },
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
  { name: 'Background',           var: '--background',           light: 'oklch(1 0 0)',             dark: 'oklch(0.145 0 0)' },
  { name: 'Foreground',           var: '--foreground',           light: 'oklch(0.145 0 0)',         dark: 'oklch(0.94 0 0)' },
  { name: 'Card',                 var: '--card',                 light: 'oklch(0.99 0 0)',          dark: 'oklch(0.21 0 0)' },
  { name: 'Card Foreground',      var: '--card-foreground',      light: 'oklch(0.145 0 0)',         dark: 'oklch(0.94 0 0)' },
  { name: 'Popover',              var: '--popover',              light: 'oklch(1 0 0)',             dark: 'oklch(0.24 0 0)' },
  { name: 'Popover Foreground',   var: '--popover-foreground',   light: 'oklch(0.145 0 0)',         dark: 'oklch(0.94 0 0)' },
  { name: 'Primary',              var: '--primary',              light: 'oklch(0.205 0 0)',         dark: 'oklch(0.94 0 0)' },
  { name: 'Primary Foreground',   var: '--primary-foreground',   light: 'oklch(0.985 0 0)',         dark: 'oklch(0.18 0 0)' },
  { name: 'Secondary',            var: '--secondary',            light: 'oklch(0.46 0 0)',          dark: 'oklch(0.55 0.01 260)' },
  { name: 'Secondary Foreground', var: '--secondary-foreground', light: 'oklch(1 0 0)',             dark: 'oklch(0.94 0 0)' },
  { name: 'Muted',                var: '--muted',                light: 'oklch(0.955 0 0)',         dark: 'oklch(0.27 0 0)' },
  { name: 'Muted Foreground',     var: '--muted-foreground',     light: 'oklch(0.45 0 0)',          dark: 'oklch(0.60 0 0)' },
  { name: 'Accent',               var: '--accent',               light: 'oklch(0.96 0 0)',          dark: 'oklch(0.25 0 0)' },
  { name: 'Accent Foreground',    var: '--accent-foreground',    light: 'oklch(0.145 0 0)',         dark: 'oklch(0.94 0 0)' },
  { name: 'Border',               var: '--border',               light: 'oklch(0.885 0 0)',         dark: 'oklch(0.30 0 0)' },
  { name: 'Input',                var: '--input',                light: 'oklch(0.905 0 0)',         dark: 'oklch(0.27 0 0)' },
  { name: 'Ring',                 var: '--ring',                 light: 'oklch(0.708 0 0)',         dark: 'oklch(0.50 0 0)' },
  { name: 'Destructive',          var: '--destructive',          light: 'oklch(0.577 0.245 27.325)', dark: 'oklch(0.396 0.141 25.723)' },
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
    id: 'logo-black',
    label: 'Logo',
    variant: 'Black',
    svgSrc: '/brandkit/Logo/Logomark/SVG/Logomark Black.svg',
    pngSrc: '/brandkit/Logo/Logomark/PNG/Logomark Black.png',
    dark: false,
  },
  {
    id: 'logo-white',
    label: 'Logo',
    variant: 'White',
    svgSrc: '/brandkit/Logo/Logomark/SVG/Logomark White.svg',
    pngSrc: '/brandkit/Logo/Logomark/PNG/Logomark White.png',
    dark: true,
  },
];

const TYPE_SCALE = [
  { token: 'text-xs', size: '0.75rem', px: '~12px', twClass: 'text-xs', use: 'Secondary labels, tooltips, KBD' },
  { token: 'text-sm', size: '0.875rem', px: '~14px', twClass: 'text-sm', use: 'Body text, menu items' },
  { token: 'text-base', size: '1rem', px: '~16px', twClass: 'text-base', use: 'Default UI text, inputs' },
  { token: 'text-lg', size: '1.125rem', px: '~18px', twClass: 'text-lg', use: 'Section headers, dialog titles' },
  { token: 'text-xl', size: '1.25rem', px: '~20px', twClass: 'text-xl', use: 'Page section titles' },
  { token: 'text-2xl', size: '1.5rem', px: '~24px', twClass: 'text-2xl', use: 'Page titles' },
  { token: 'text-3xl', size: '1.875rem', px: '~30px', twClass: 'text-3xl', use: 'Hero subheadings' },
  { token: 'text-4xl', size: '2.25rem', px: '~36px', twClass: 'text-4xl', use: 'Display / hero headings' },
  { token: 'text-5xl', size: '3rem', px: '~48px', twClass: 'text-5xl', use: 'Marketing display' },
  { token: 'text-6xl', size: '3.75rem', px: '~60px', twClass: 'text-6xl', use: 'Large display' },
  { token: 'text-7xl', size: '4.5rem', px: '~72px', twClass: 'text-7xl', use: 'Oversized display' },
  { token: 'text-8xl', size: '6rem', px: '~96px', twClass: 'text-8xl', use: 'Hero numerals / clocks' },
] as const;

const MOTION_DURATIONS = [
  { name: 'Fast', token: '--duration-fast', ms: 100 },
  { name: 'Normal', token: '--duration-normal', ms: 150 },
  { name: 'Moderate', token: '--duration-moderate', ms: 200 },
  { name: 'Slow', token: '--duration-slow', ms: 300 },
  { name: 'Slower', token: '--duration-slower', ms: 500 },
] as const;

const EASING_CURVES = [
  { name: 'Default', token: '--ease-default', value: 'cubic-bezier(0.2, 0, 0, 1)' },
  { name: 'Ease In', token: '--ease-in', value: 'cubic-bezier(0.4, 0, 1, 1)' },
  { name: 'Ease Out', token: '--ease-out', value: 'cubic-bezier(0, 0, 0.2, 1)' },
  { name: 'Ease In-Out', token: '--ease-in-out', value: 'cubic-bezier(0.4, 0, 0.2, 1)' },
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
  { id: 'components', label: 'Components', children: [
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
  ]},
  { id: 'page-patterns', label: 'Page Patterns', children: [
    { id: 'pat-page-header', label: 'PageHeader' },
    { id: 'pat-spotlight-card', label: 'SpotlightCard' },
    { id: 'pat-search-bar', label: 'PageSearchBar' },
    { id: 'pat-stagger', label: 'Stagger Mount' },
  ]},
  { id: 'patterns', label: 'Primitives', children: [
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
  ]},
  { id: 'anti-patterns', label: 'Anti-Patterns' },
  { id: 'usage', label: 'Usage' },
] as const;

/* All section IDs flattened for intersection observer */
const ALL_SECTION_IDS = TOC_SECTIONS.flatMap((s) =>
  'children' in s && s.children
    ? [s.id, ...s.children.map((c) => c.id)]
    : [s.id]
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
      className="inline-flex items-center gap-1.5 group cursor-pointer"
    >
      <span className="font-mono text-xs text-muted-foreground group-hover:text-foreground transition-colors">
        {value}
      </span>
      {copied ? (
        <Check className="size-2.5 text-emerald-500" />
      ) : (
        <Copy className="size-2.5 text-muted-foreground group-hover:text-muted-foreground transition-colors" />
      )}
    </button>
  );
}

function LogoCard({ asset, fmt }: { asset: LogoAsset; fmt: LogoFormat }) {
  const isWide = asset.label !== 'Symbol';
  const downloadHref = fmt === 'png' ? asset.pngSrc : asset.svgSrc;
  const downloadName = `kortix-${asset.label.toLowerCase()}-${asset.variant.toLowerCase()}.${fmt}`;

  return (
    <div className="group relative">
      <div
        className={cn(
          'aspect-[3/2] rounded-lg flex items-center justify-center transition-colors relative overflow-hidden',
          isWide ? 'px-6 py-8' : 'p-10',
          asset.dark
            ? 'bg-neutral-950 ring-1 ring-white/[0.06]'
            : 'bg-white ring-1 ring-black/[0.06]'
        )}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={asset.svgSrc}
          alt={`Kortix ${asset.label} ${asset.variant}`}
          className={cn(
            'object-contain',
            isWide
              ? 'max-h-8 md:max-h-10 w-full'
              : 'max-h-10 md:max-h-12 w-auto'
          )}
        />

        <a
          href={downloadHref}
          download={downloadName}
          className="absolute inset-0 flex items-center justify-center rounded-lg opacity-0 group-hover:opacity-100 transition-opacity bg-black/[0.04] dark:bg-white/[0.04] cursor-pointer"
        >
          <span className="flex items-center gap-1.5 text-xs font-medium bg-background ring-1 ring-border rounded-full px-3 py-1.5 shadow-sm">
            <Download className="size-3" /> {fmt.toUpperCase()}
          </span>
        </a>
      </div>

      <div className="mt-2 flex items-baseline gap-1.5 px-0.5">
        <span className="text-xs font-medium text-foreground">
          {asset.label}
        </span>
        <span className="text-xs font-mono text-muted-foreground">
          {asset.variant}
        </span>
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
    <div className="flex items-center gap-0.5 bg-foreground/[0.05] rounded-full p-0.5">
      {(['svg', 'png'] as const).map((f) => (
        <button
          key={f}
          onClick={() => onChange(f)}
          className={cn(
            'text-xs font-mono px-3 py-1 rounded-full transition-colors cursor-pointer',
            value === f
              ? 'bg-background text-foreground shadow-sm ring-1 ring-foreground/[0.06]'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          {f.toUpperCase()}
        </button>
      ))}
    </div>
  );
}

function DemoContainer({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'rounded-2xl ring-1 ring-border/50 bg-card/30 p-6',
        className
      )}
    >
      {children}
    </div>
  );
}

function SectionDivider() {
  return <div className="mt-14 pt-8 border-t border-border/50" />;
}

function ComponentLabel({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-xs uppercase tracking-widest text-muted-foreground mb-2">
      {children}
    </h3>
  );
}

function ComponentDesc({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-sm text-muted-foreground leading-relaxed mb-4">
      {children}
    </p>
  );
}

/* ─── Motion Demo ─── */

function MotionBar({
  label,
  durationMs,
  easing = 'cubic-bezier(0.2, 0, 0, 1)',
}: {
  label: string;
  durationMs: number;
  easing?: string;
}) {
  const [active, setActive] = useState(false);

  return (
    <div className="flex items-center gap-4">
      <button
        type="button"
        onClick={() => setActive((p) => !p)}
        className="text-xs font-mono text-muted-foreground hover:text-foreground transition-colors cursor-pointer w-24 shrink-0 text-left"
      >
        {label}
      </button>
      <div className="flex-1 h-7 bg-muted/30 rounded-md relative overflow-hidden">
        <div
          className="absolute top-1 bottom-1 left-1 rounded-sm bg-foreground/70"
          style={{
            width: active ? 'calc(100% - 8px)' : '24px',
            transitionProperty: 'width',
            transitionDuration: `${durationMs}ms`,
            transitionTimingFunction: easing,
          }}
        />
      </div>
      <span className="text-xs font-mono text-muted-foreground w-14 shrink-0 text-right">
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
    <div className="rounded-xl ring-1 ring-border/50 overflow-hidden">
      <div className="px-5 py-4 border-b border-border/30">
        <h4 className="text-sm font-medium text-foreground">{title}</h4>
        <p className="text-xs text-muted-foreground mt-1">{description}</p>
      </div>
      <div className="grid md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-border/30">
        <div className="p-4">
          <div className="flex items-center gap-1.5 mb-2.5">
            <X className="size-3 text-red-500" />
            <span className="text-xs uppercase tracking-widest text-red-500/70 font-medium">{tHardcodedUi.raw('appHomeDesignSystemPage.line566JsxTextDonAposT')}</span>
          </div>
          <pre className="text-xs font-mono text-muted-foreground whitespace-pre-wrap leading-relaxed bg-muted/30 rounded-lg p-3 overflow-x-auto">
            {bad}
          </pre>
        </div>
        <div className="p-4">
          <div className="flex items-center gap-1.5 mb-2.5">
            <Check className="size-3 text-emerald-500" />
            <span className="text-xs uppercase tracking-widest text-emerald-500/70 font-medium">
              Do
            </span>
          </div>
          <pre className="text-xs font-mono text-muted-foreground whitespace-pre-wrap leading-relaxed bg-muted/30 rounded-lg p-3 overflow-x-auto">
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
      { rootMargin: '-20% 0px -70% 0px', threshold: 0 }
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
    <nav className="hidden lg:block sticky top-20 self-start w-48 shrink-0 pt-2">
      <ul className="space-y-0.5">
        {TOC_SECTIONS.map((s) => {
          const isParentActive = s.id === activeParentId;
          const hasChildren = 'children' in s && s.children;
          return (
            <li key={s.id}>
              <a
                href={`#${s.id}`}
                className={cn(
                  'text-xs block py-1 transition-colors',
                  activeId === s.id || isParentActive
                    ? 'text-foreground font-medium'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {s.label}
              </a>
              {hasChildren && isParentActive && (
                <ul className="ml-2.5 border-l border-border/30 pl-2.5 mt-0.5 mb-1 space-y-0">
                  {s.children.map((c) => (
                    <li key={c.id}>
                      <a
                        href={`#${c.id}`}
                        className={cn(
                          'text-xs block py-0.5 transition-colors',
                          activeId === c.id
                            ? 'text-foreground font-medium'
                            : 'text-muted-foreground hover:text-foreground'
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
  const [selectedDate, setSelectedDate] = useState<Date | undefined>(
    new Date()
  );
  const [sliderValue, setSliderValue] = useState([50]);
  const [togglePressed, setTogglePressed] = useState(true);
  const [collapsibleOpen, setCollapsibleOpen] = useState(false);

  return (
    <main className="min-h-screen bg-background">
      <div className="max-w-5xl mx-auto px-6 pt-24 sm:pt-32 pb-24 sm:pb-32">
        <div className="flex gap-16">
          {/* TOC sidebar — desktop only */}
          <TocSidebar />

          {/* Main content */}
          <div className="flex-1 max-w-3xl">
            {/* ═══════════════ Hero ═══════════════ */}
            <section id="hero">
              <div className="mb-3">
                  <Badge variant="outline" className="text-xs font-mono">
                    v1.0
                  </Badge>
                </div>
                <h1 className="text-3xl sm:text-4xl md:text-5xl font-medium tracking-tight text-foreground mb-5">{tHardcodedUi.raw('appHomeDesignSystemPage.line700JsxTextBrandAmpDesignSystem')}</h1>
                <p className="text-base text-muted-foreground leading-relaxed max-w-xl">{tHardcodedUi.raw('appHomeDesignSystemPage.line703JsxTextLogoAssetsColorPaletteTypographyMotionTokensComponent')}</p>
                <div className="flex flex-wrap gap-2 mt-6">
                  <Badge variant="secondary">
                    <span className="font-mono">30+</span> Components
                  </Badge>
                  <Badge variant="secondary">
                    <span className="font-mono">7</span> Themes
                  </Badge>
                  <Badge variant="secondary">{tHardcodedUi.raw('appHomeDesignSystemPage.line714JsxTextOklchColors')}</Badge>
                  <Badge variant="secondary">{tHardcodedUi.raw('appHomeDesignSystemPage.line715JsxTextRadixPrimitives')}</Badge>
                </div>
            </section>

            {/* ═══════════════ Logo ═══════════════ */}
            <section id="logo" className="mt-14">
              <div className="flex items-center justify-between mb-5">
                  <h2 className="text-xs uppercase tracking-widest text-muted-foreground">
                    Logo
                  </h2>
                  <FormatToggle value={logoFmt} onChange={setLogoFmt} />
                </div>
                <p className="text-base text-muted-foreground leading-relaxed mb-6">{tHardcodedUi.raw('appHomeDesignSystemPage.line728JsxTextTwoFormsTheSymbolAndTheWordmarkEach')}</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {LOGO_ASSETS.map((a) => (
                    <LogoCard key={a.id} asset={a} fmt={logoFmt} />
                  ))}
                </div>
                <p className="text-sm text-muted-foreground leading-relaxed mt-6">{tHardcodedUi.raw('appHomeDesignSystemPage.line737JsxTextTheSymbolIsDerivedFromTheLetterK')}{"'"}{tHardcodedUi.raw('appHomeDesignSystemPage.line739JsxTextTPracticalNeverStretchRotateOrRecolorIt')}</p>
            </section>

            {/* ═══════════════ Colors ═══════════════ */}
            <section id="colors">
              <SectionDivider />
                <h2 className="text-xs uppercase tracking-widest text-muted-foreground mb-5">
                  Colors
                </h2>
                <p className="text-base text-muted-foreground leading-relaxed mb-6">{tHardcodedUi.raw('appHomeDesignSystemPage.line751JsxTextBlackAndWhiteIsTheFoundationEachUi')}</p>

                {/* Foundation */}
                <div className="mb-8">
                  <p className="text-xs text-muted-foreground mb-3">
                    Foundation
                  </p>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    {BRAND_COLORS.map((c) => (
                      <div key={c.hex}>
                        <div
                          className={cn(
                            'aspect-[4/3] rounded-lg',
                            c.light ? 'ring-1 ring-black/[0.08]' : ''
                          )}
                          style={{ backgroundColor: c.hex }}
                        />
                        <div className="mt-2 px-0.5 space-y-0.5">
                          <span className="text-xs font-medium text-foreground">
                            {c.name}
                          </span>
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
                  <div className="flex items-baseline justify-between mb-3">
                    <p className="text-xs text-muted-foreground">{tHardcodedUi.raw('appHomeDesignSystemPage.line791JsxTextCorePalette')}</p>
                    <p className="font-mono text-xs text-muted-foreground/70">{tHardcodedUi.raw('appHomeDesignSystemPage.line794JsxTextGlobalsCssRootDark')}</p>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {CORE_PALETTE.map((token) => (
                      <div
                        key={token.var}
                        className="rounded-lg border border-border/50 overflow-hidden"
                      >
                        <div className="grid grid-cols-2 h-14">
                          <div
                            className="relative ring-1 ring-inset ring-black/[0.06]"
                            style={{ backgroundColor: token.light }}
                          >
                            <span className="absolute bottom-1 left-2 text-xs font-mono text-black/55 uppercase tracking-widest">
                              light
                            </span>
                          </div>
                          <div
                            className="relative ring-1 ring-inset ring-white/[0.06]"
                            style={{ backgroundColor: token.dark }}
                          >
                            <span className="absolute bottom-1 left-2 text-xs font-mono text-white/55 uppercase tracking-widest">
                              dark
                            </span>
                          </div>
                        </div>
                        <div className="px-3 py-2.5 bg-background">
                          <div className="flex items-baseline justify-between gap-2 mb-1">
                            <span className="text-xs font-medium text-foreground truncate">
                              {token.name}
                            </span>
                            <span className="font-mono text-xs text-muted-foreground shrink-0">
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
                <h2 className="text-xs uppercase tracking-widest text-muted-foreground mb-5">
                  Typography
                </h2>
                <p className="text-base text-muted-foreground leading-relaxed mb-8">{tHardcodedUi.raw('appHomeDesignSystemPage.line848JsxTextRoobertAGeometricSansSerifFontMedium500')}</p>

                {/* Weight showcase */}
                <div className="space-y-6">
                  {[
                    { label: 'Medium · 500', cls: 'font-medium' },
                    { label: 'Regular · 400', cls: 'font-normal' },
                  ].map((s) => (
                    <div
                      key={s.label}
                      className="border-b border-border/30 pb-5"
                    >
                      <span className="font-mono text-xs text-muted-foreground tracking-widest block mb-2">
                        {s.label}
                      </span>
                      <p
                        className={cn(
                          'text-3xl md:text-5xl tracking-tight text-foreground',
                          s.cls
                        )}
                      >{tHardcodedUi.raw('appHomeDesignSystemPage.line871JsxTextKortixComputer')}</p>
                    </div>
                  ))}
                </div>

                {/* Mono showcase */}
                <div className="bg-neutral-950 text-neutral-100 rounded-lg p-5 md:p-6 mt-6">
                  <span className="font-mono text-xs text-neutral-500 tracking-widest block mb-3">{tHardcodedUi.raw('appHomeDesignSystemPage.line880JsxTextRoobertMono')}</span>
                  <p className="font-mono text-lg md:text-2xl tracking-tight">{tHardcodedUi.raw('appHomeDesignSystemPage.line883JsxTextConstAgentNewKortix')}</p>
                  <p className="font-mono text-xs text-neutral-600 mt-4">{tHardcodedUi.raw('appHomeDesignSystemPage.line886JsxTextAbcdefghijklmnopqrstuvwxyzAbcdefghijklmnopqrstuvwxyz0123456789')}</p>
                </div>

                {/* Type scale table */}
                <div className="mt-8">
                  <p className="text-xs text-muted-foreground mb-4">{tHardcodedUi.raw('appHomeDesignSystemPage.line894JsxTextTypeScale')}</p>
                  <div className="space-y-0">
                    {TYPE_SCALE.map((t) => (
                      <div
                        key={t.token}
                        className="flex items-baseline gap-4 py-3 border-b border-border/20"
                      >
                        <div className="w-24 shrink-0">
                          <span className="font-mono text-xs text-muted-foreground">
                            {t.token}
                          </span>
                        </div>
                        <div className="w-16 shrink-0">
                          <span className="font-mono text-xs text-muted-foreground">
                            {t.px}
                          </span>
                        </div>
                        <div className="flex-1 min-w-0">
                          <span
                            className="text-foreground font-medium truncate block"
                            style={{ fontSize: t.size }}
                          >{tHardcodedUi.raw('appHomeDesignSystemPage.line917JsxTextTheQuickBrownFox')}</span>
                        </div>
                        <div className="hidden sm:block shrink-0 max-w-48">
                          <span className="text-xs text-muted-foreground truncate block">
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
                <h2 className="text-xs uppercase tracking-widest text-muted-foreground mb-5">
                  Motion
                </h2>
                <p className="text-base text-muted-foreground leading-relaxed mb-6">{tHardcodedUi.raw('appHomeDesignSystemPage.line938JsxTextStandardizedDurationAndEasingTokensEnsureEveryTransition')}</p>

                {/* Duration scale */}
                <div className="mb-8">
                  <p className="text-xs text-muted-foreground mb-4">{tHardcodedUi.raw('appHomeDesignSystemPage.line946JsxTextDurationScale')}</p>
                  <DemoContainer>
                    <div className="space-y-3">
                      {MOTION_DURATIONS.map((d) => (
                        <MotionBar
                          key={d.token}
                          label={d.name}
                          durationMs={d.ms}
                        />
                      ))}
                    </div>
                  </DemoContainer>
                </div>

                {/* Easing curves */}
                <div>
                  <p className="text-xs text-muted-foreground mb-4">{tHardcodedUi.raw('appHomeDesignSystemPage.line964JsxTextEasingCurves')}</p>
                  <DemoContainer>
                    <div className="space-y-3">
                      {EASING_CURVES.map((e) => (
                        <MotionBar
                          key={e.token}
                          label={e.name}
                          durationMs={300}
                          easing={e.value}
                        />
                      ))}
                    </div>
                  </DemoContainer>
                </div>
            </section>

            {/* ═══════════════ Spacing ═══════════════ */}
            <section id="spacing">
              <SectionDivider />
                <h2 className="text-xs uppercase tracking-widest text-muted-foreground mb-5">
                  Spacing
                </h2>
                <p className="text-base text-muted-foreground leading-relaxed mb-6">{tHardcodedUi.raw('appHomeDesignSystemPage.line988JsxTextAConsistentSpacingScaleBasedOn4pxIncrements')}</p>

                <DemoContainer>
                  <div className="space-y-2.5">
                    {SPACING_SCALE.map((s) => (
                      <div key={s.token} className="flex items-center gap-4">
                        <span className="font-mono text-xs text-muted-foreground w-8 shrink-0 text-right">
                          {s.token}
                        </span>
                        <div
                          className="h-5 rounded-sm bg-foreground/60"
                          style={{ width: `${s.px * 3}px` }}
                        />
                        <span className="font-mono text-xs text-muted-foreground">
                          {s.px}px
                        </span>
                      </div>
                    ))}
                  </div>
                </DemoContainer>
            </section>

            {/* ═══════════════ Components ═══════════════ */}
            <section id="components">
              <SectionDivider />
                <h2 className="text-xs uppercase tracking-widest text-muted-foreground mb-5">
                  Components
                </h2>
                <p className="text-base text-muted-foreground leading-relaxed mb-8">{tHardcodedUi.raw('appHomeDesignSystemPage.line1019JsxTextTheCompleteComponentLibraryEachComponentUsesA')}</p>

                {/* ─── Button ─── */}
                <div id="comp-button" className="mb-12">
                  <ComponentLabel>Button</ComponentLabel>
                  <ComponentDesc>{tHardcodedUi.raw('appHomeDesignSystemPage.line1029JsxTextText10Variants8SizesTheFoundationOfEvery')}<code className="font-mono text-xs bg-muted px-1 rounded">rounded-full</code>{tHardcodedUi.raw('appHomeDesignSystemPage.line1030JsxTextEveryContainerCardsDialogsInputsTextareasSelectsInfo')}<code className="font-mono text-xs bg-muted px-1 rounded">rounded-2xl</code>{tHardcodedUi.raw('appHomeDesignSystemPage.line1031JsxTextNeverPut')}<code className="font-mono text-xs bg-muted px-1 rounded">rounded-sm/md/lg/xl</code>{tHardcodedUi.raw('appHomeDesignSystemPage.line1032JsxTextOnABoxThe')}<code className="font-mono text-xs bg-muted px-1 rounded">destructive</code>{tHardcodedUi.raw('appHomeDesignSystemPage.line1033JsxTextVariantIsReservedForThe')}<strong>{tHardcodedUi.raw('appHomeDesignSystemPage.line1033JsxTextOneIrreversibleConfirm')}</strong>{tHardcodedUi.raw('appHomeDesignSystemPage.line1033JsxTextAConfirmdialogAposSPrimaryActionTheDanger')}</ComponentDesc>
                  <DemoContainer>
                    <div className="space-y-6">
                      {/* Base Variants */}
                      <div>
                        <p className="text-xs text-muted-foreground mb-3 uppercase tracking-wider">{tHardcodedUi.raw('appHomeDesignSystemPage.line1039JsxTextBaseVariants')}</p>
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
                        <p className="text-xs text-muted-foreground mb-3 uppercase tracking-wider">{tHardcodedUi.raw('appHomeDesignSystemPage.line1051JsxTextKortixVariants')}</p>
                        <div className="flex flex-wrap gap-2">
                          <Button variant="subtle">Subtle</Button>
                          <Button variant="muted">Muted</Button>
                          <Button variant="inverse">Inverse</Button>
                          <Button variant="success">Success</Button>
                        </div>
                      </div>
                      {/* Standard Sizes */}
                      <div>
                        <p className="text-xs text-muted-foreground mb-3 uppercase tracking-wider">{tHardcodedUi.raw('appHomeDesignSystemPage.line1061JsxTextStandardSizes')}</p>
                        <div className="flex flex-wrap items-center gap-2">
                          <Button size="lg">Large</Button>
                          <Button size="default">Default</Button>
                          <Button size="sm">Small</Button>
                          <Button size="icon"><Settings className="size-4" /></Button>
                        </div>
                      </div>
                      {/* Compact Sizes */}
                      <div>
                        <p className="text-xs text-muted-foreground mb-3 uppercase tracking-wider">{tHardcodedUi.raw('appHomeDesignSystemPage.line1071JsxTextCompactSizes')}</p>
                        <div className="flex flex-wrap items-center gap-2">
                          <Button size="toolbar" variant="muted">Toolbar</Button>
                          <Button size="xs" variant="muted">XSmall</Button>
                          <Button size="icon-sm" variant="ghost"><Settings className="size-3.5" /></Button>
                          <Button size="icon-xs" variant="ghost"><X className="size-3" /></Button>
                        </div>
                      </div>
                      {/* With Icons */}
                      <div>
                        <p className="text-xs text-muted-foreground mb-3 uppercase tracking-wider">{tHardcodedUi.raw('appHomeDesignSystemPage.line1081JsxTextWithIcons')}</p>
                        <div className="flex flex-wrap items-center gap-2">
                          <Button><Mail className="size-4" />{tHardcodedUi.raw('appHomeDesignSystemPage.line1083JsxTextSendEmail')}</Button>
                          <Button variant="outline"><Plus className="size-4" /> Create</Button>
                          <Button variant="subtle"><Search className="size-4" /> Search</Button>
                          <Button variant="destructive"><Trash2 className="size-4" /> Delete</Button>
                          <Button variant="inverse"><ArrowRight className="size-4" /> Launch</Button>
                          <Button variant="success" size="toolbar"><Check className="size-3.5" /> Confirm</Button>
                        </div>
                      </div>
                      {/* States */}
                      <div>
                        <p className="text-xs text-muted-foreground mb-3 uppercase tracking-wider">States</p>
                        <div className="flex flex-wrap items-center gap-2">
                          <Button disabled>Disabled</Button>
                          <Button disabled variant="outline">{tHardcodedUi.raw('appHomeDesignSystemPage.line1096JsxTextDisabledOutline')}</Button>
                          <Button><Loader2 className="size-4 animate-spin" /> Loading</Button>
                        </div>
                      </div>
                    </div>
                  </DemoContainer>
                </div>

                {/* ─── Badge ─── */}
                <div id="comp-badge" className="mb-12">
                  <ComponentLabel>Badge</ComponentLabel>
                  <ComponentDesc>{tHardcodedUi.raw('appHomeDesignSystemPage.line1108JsxTextLabelsStatusIndicatorsAndTagsSevenVariantsFrom')}</ComponentDesc>
                  <DemoContainer>
                    <div className="space-y-4">
                      <div>
                        <p className="text-xs text-muted-foreground mb-3 uppercase tracking-wider">{tHardcodedUi.raw('appHomeDesignSystemPage.line1114JsxTextBaseVariants')}</p>
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
                        <p className="text-xs text-muted-foreground mb-3 uppercase tracking-wider">{tHardcodedUi.raw('appHomeDesignSystemPage.line1126JsxTextSemanticStatus')}</p>
                        <div className="flex flex-wrap gap-2">
                          <Badge variant="success">Success</Badge>
                          <Badge variant="warning">Warning</Badge>
                          <Badge variant="info">Info</Badge>
                          <Badge variant="muted">Muted</Badge>
                        </div>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground mb-3 uppercase tracking-wider">Sizes</p>
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge variant="default">Default</Badge>
                          <Badge variant="default" size="sm">Small</Badge>
                          <Badge variant="success" size="sm">Active</Badge>
                          <Badge variant="warning" size="sm">Pending</Badge>
                        </div>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground mb-3 uppercase tracking-wider">{tHardcodedUi.raw('appHomeDesignSystemPage.line1144JsxTextWithIcons')}</p>
                        <div className="flex flex-wrap gap-2">
                          <Badge variant="default"><Star className="size-3" />Featured</Badge>
                          <Badge variant="success"><Check className="size-3" />Verified</Badge>
                          <Badge variant="info"><Info className="size-3" />v2.1.0</Badge>
                          <Badge variant="warning"><AlertTriangle className="size-3" />Pending</Badge>
                        </div>
                      </div>
                    </div>
                  </DemoContainer>
                </div>

                {/* ─── Card ─── */}
                <div id="comp-card" className="mb-12">
                  <ComponentLabel>Card</ComponentLabel>
                  <ComponentDesc>{tHardcodedUi.raw('appHomeDesignSystemPage.line1160JsxTextContainerWithHeaderContentAndFooterSlotsDefault')}</ComponentDesc>
                  <DemoContainer>
                    <div className="grid sm:grid-cols-2 gap-4">
                      <Card variant="default">
                        <CardHeader>
                          <CardTitle>{tHardcodedUi.raw('appHomeDesignSystemPage.line1167JsxTextDefaultCard')}</CardTitle>
                          <CardDescription>{tHardcodedUi.raw('appHomeDesignSystemPage.line1169JsxTextStandardCardWithSolidBackground')}</CardDescription>
                        </CardHeader>
                        <CardContent>
                          <p className="text-sm text-muted-foreground">{tHardcodedUi.raw('appHomeDesignSystemPage.line1174JsxTextCardContentGoesHereUseForGroupingRelated')}</p>
                        </CardContent>
                        <CardFooter>
                          <Button variant="outline" size="sm">
                            Action
                          </Button>
                        </CardFooter>
                      </Card>
                      <Card variant="glass">
                        <CardHeader>
                          <CardTitle>{tHardcodedUi.raw('appHomeDesignSystemPage.line1186JsxTextGlassCard')}</CardTitle>
                          <CardDescription>{tHardcodedUi.raw('appHomeDesignSystemPage.line1188JsxTextTranslucentSurfaceForOverlaysAndPanels')}</CardDescription>
                        </CardHeader>
                        <CardContent>
                          <p className="text-sm text-muted-foreground">{tHardcodedUi.raw('appHomeDesignSystemPage.line1193JsxTextCardContentGoesHereUsedForOverlaysAnd')}</p>
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
                  <ComponentDesc>{tHardcodedUi.raw('appHomeDesignSystemPage.line1211JsxTextTextInputForFormsAndSearchTheCanonical')}</ComponentDesc>
                  <DemoContainer>
                    <div className="space-y-4 max-w-sm">
                      <div className="space-y-2">
                        <Label htmlFor="demo-input">Label</Label>
                        <Input type="text"
                          id="demo-input"
                          placeholder={tHardcodedUi.raw('appHomeDesignSystemPage.line1221JsxAttrPlaceholderDefaultInput')}
                        />
                      </div>
                      <Input type="text" placeholder={tHardcodedUi.raw('appHomeDesignSystemPage.line1224JsxAttrPlaceholderWithPlaceholder')} />
                      <Input type="password" placeholder={tHardcodedUi.raw('appHomeDesignSystemPage.line1225JsxAttrPlaceholderPasswordInput')} />
                      <Input type="text" disabled placeholder="Disabled" />
                    </div>
                  </DemoContainer>
                </div>

                {/* ─── Textarea ─── */}
                <div id="comp-textarea" className="mb-12">
                  <ComponentLabel>Textarea</ComponentLabel>
                  <ComponentDesc>{tHardcodedUi.raw('appHomeDesignSystemPage.line1235JsxTextMultiLineTextInputForLongerContentShares')}</ComponentDesc>
                  <DemoContainer>
                    <div className="space-y-4 max-w-sm">
                      <Textarea placeholder={tHardcodedUi.raw('appHomeDesignSystemPage.line1241JsxAttrPlaceholderWriteSomething')} />
                      <Textarea disabled placeholder={tHardcodedUi.raw('appHomeDesignSystemPage.line1242JsxAttrPlaceholderDisabledTextarea')} />
                    </div>
                  </DemoContainer>
                </div>

                {/* ─── Select ─── */}
                <div id="comp-select" className="mb-12">
                  <ComponentLabel>Select</ComponentLabel>
                  <ComponentDesc>{tHardcodedUi.raw('appHomeDesignSystemPage.line1251JsxTextDropdownSelectionFromAListOfOptionsMatches')}</ComponentDesc>
                  <DemoContainer>
                    <div className="max-w-xs">
                      <Select>
                        <SelectTrigger>
                          <SelectValue placeholder={tHardcodedUi.raw('appHomeDesignSystemPage.line1259JsxAttrPlaceholderSelectAFramework')} />
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
                  <ComponentDesc>{tHardcodedUi.raw('appHomeDesignSystemPage.line1276JsxTextToggleForBooleanValues')}</ComponentDesc>
                  <DemoContainer>
                    <div className="space-y-4">
                      <div className="flex items-center gap-2">
                        <Checkbox
                          id="check-1"
                          checked={checkboxChecked}
                          onCheckedChange={(v) =>
                            setCheckboxChecked(v as boolean)
                          }
                        />
                        <Label htmlFor="check-1">Checked</Label>
                      </div>
                      <div className="flex items-center gap-2">
                        <Checkbox id="check-2" />
                        <Label htmlFor="check-2">Unchecked</Label>
                      </div>
                      <div className="flex items-center gap-2">
                        <Checkbox id="check-3" disabled />
                        <Label
                          htmlFor="check-3"
                          className="text-muted-foreground"
                        >
                          Disabled
                        </Label>
                      </div>
                    </div>
                  </DemoContainer>
                </div>

                {/* ─── Switch ─── */}
                <div id="comp-switch" className="mb-12">
                  <ComponentLabel>Switch</ComponentLabel>
                  <ComponentDesc>{tHardcodedUi.raw('appHomeDesignSystemPage.line1311JsxTextToggleControlForOnOffStates')}</ComponentDesc>
                  <DemoContainer>
                    <div className="space-y-4">
                      <div className="flex items-center gap-3">
                        <Switch
                          id="switch-on"
                          checked={switchOn}
                          onCheckedChange={setSwitchOn}
                        />
                        <Label htmlFor="switch-on">On</Label>
                      </div>
                      <div className="flex items-center gap-3">
                        <Switch
                          id="switch-off"
                          checked={switchOff}
                          onCheckedChange={setSwitchOff}
                        />
                        <Label htmlFor="switch-off">Off</Label>
                      </div>
                      <div className="flex items-center gap-3">
                        <Switch id="switch-dis" disabled />
                        <Label
                          htmlFor="switch-dis"
                          className="text-muted-foreground"
                        >
                          Disabled
                        </Label>
                      </div>
                    </div>
                  </DemoContainer>
                </div>

                {/* ─── Toggle ─── */}
                <div id="comp-toggle" className="mb-12">
                  <ComponentLabel>Toggle</ComponentLabel>
                  <ComponentDesc>{tHardcodedUi.raw('appHomeDesignSystemPage.line1348JsxTextATwoStateButtonWithDefaultAndOutline')}</ComponentDesc>
                  <DemoContainer>
                    <div className="flex flex-wrap gap-2">
                      <Toggle
                        variant="default"
                        pressed={togglePressed}
                        onPressedChange={setTogglePressed}
                        aria-label={tHardcodedUi.raw('appHomeDesignSystemPage.line1356JsxAttrAriaLabelToggleBold')}
                      >
                        <Bold className="size-4" />
                      </Toggle>
                      <Toggle variant="outline" aria-label={tHardcodedUi.raw('appHomeDesignSystemPage.line1360JsxAttrAriaLabelToggleSettings')}>
                        <Settings className="size-4" />
                      </Toggle>
                    </div>
                  </DemoContainer>
                </div>

                {/* ─── Radio Group ─── */}
                <div id="comp-radio" className="mb-12">
                  <ComponentLabel>{tHardcodedUi.raw('appHomeDesignSystemPage.line1369JsxTextRadioGroup')}</ComponentLabel>
                  <ComponentDesc>{tHardcodedUi.raw('appHomeDesignSystemPage.line1371JsxTextSingleSelectionFromASetOfOptions')}</ComponentDesc>
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
                  <ComponentDesc>{tHardcodedUi.raw('appHomeDesignSystemPage.line1395JsxTextTabbedNavigationWithStandardAndCompactVariants')}</ComponentDesc>
                  <DemoContainer>
                    <div className="space-y-6">
                      <div>
                        <p className="text-xs text-muted-foreground mb-3">
                          Standard
                        </p>
                        <Tabs defaultValue="tab1">
                          <TabsList>
                            <TabsTrigger value="tab1">Account</TabsTrigger>
                            <TabsTrigger value="tab2">Password</TabsTrigger>
                            <TabsTrigger value="tab3">Settings</TabsTrigger>
                          </TabsList>
                          <TabsContent value="tab1">
                            <p className="text-sm text-muted-foreground mt-2">{tHardcodedUi.raw('appHomeDesignSystemPage.line1411JsxTextAccountSettingsAndPreferences')}</p>
                          </TabsContent>
                          <TabsContent value="tab2">
                            <p className="text-sm text-muted-foreground mt-2">{tHardcodedUi.raw('appHomeDesignSystemPage.line1416JsxTextChangeYourPassword')}</p>
                          </TabsContent>
                          <TabsContent value="tab3">
                            <p className="text-sm text-muted-foreground mt-2">{tHardcodedUi.raw('appHomeDesignSystemPage.line1421JsxTextGeneralSettings')}</p>
                          </TabsContent>
                        </Tabs>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground mb-3">
                          Compact
                        </p>
                        <Tabs defaultValue="c1">
                          <TabsListCompact>
                            <TabsTriggerCompact value="c1">
                              Day
                            </TabsTriggerCompact>
                            <TabsTriggerCompact value="c2">
                              Week
                            </TabsTriggerCompact>
                            <TabsTriggerCompact value="c3">
                              Month
                            </TabsTriggerCompact>
                          </TabsListCompact>
                          <TabsContent value="c1">
                            <p className="text-sm text-muted-foreground mt-2">{tHardcodedUi.raw('appHomeDesignSystemPage.line1444JsxTextDailyViewContent')}</p>
                          </TabsContent>
                          <TabsContent value="c2">
                            <p className="text-sm text-muted-foreground mt-2">{tHardcodedUi.raw('appHomeDesignSystemPage.line1449JsxTextWeeklyViewContent')}</p>
                          </TabsContent>
                          <TabsContent value="c3">
                            <p className="text-sm text-muted-foreground mt-2">{tHardcodedUi.raw('appHomeDesignSystemPage.line1454JsxTextMonthlyViewContent')}</p>
                          </TabsContent>
                        </Tabs>
                      </div>
                    </div>
                  </DemoContainer>
                </div>

                {/* ─── Dialog ─── */}
                <div id="comp-dialog" className="mb-12">
                  <ComponentLabel>Dialog</ComponentLabel>
                  <ComponentDesc>{tHardcodedUi.raw('appHomeDesignSystemPage.line1467JsxTextModalOverlayForFocusedInteractions')}</ComponentDesc>
                  <DemoContainer>
                    <Dialog>
                      <DialogTrigger asChild>
                        <Button variant="outline">{tHardcodedUi.raw('appHomeDesignSystemPage.line1472JsxTextOpenDialog')}</Button>
                      </DialogTrigger>
                      <DialogContent>
                        <DialogHeader>
                          <DialogTitle>{tHardcodedUi.raw('appHomeDesignSystemPage.line1476JsxTextDialogTitle')}</DialogTitle>
                          <DialogDescription>{tHardcodedUi.raw('appHomeDesignSystemPage.line1478JsxTextThisIsADescriptionOfTheDialogContent')}</DialogDescription>
                        </DialogHeader>
                        <div className="py-4">
                          <p className="text-sm text-muted-foreground">{tHardcodedUi.raw('appHomeDesignSystemPage.line1484JsxTextDialogBodyContentGoesHere')}</p>
                        </div>
                        <DialogFooter>
                          <Button variant="outline">Cancel</Button>
                          <Button>Confirm</Button>
                        </DialogFooter>
                      </DialogContent>
                    </Dialog>
                  </DemoContainer>
                </div>

                {/* ─── Sheet ─── */}
                <div id="comp-sheet" className="mb-12">
                  <ComponentLabel>Sheet</ComponentLabel>
                  <ComponentDesc>{tHardcodedUi.raw('appHomeDesignSystemPage.line1500JsxTextSlideOutPanelFromTheEdgeOfThe')}</ComponentDesc>
                  <DemoContainer>
                    <Sheet>
                      <SheetTrigger asChild>
                        <Button variant="outline">{tHardcodedUi.raw('appHomeDesignSystemPage.line1505JsxTextOpenSheet')}</Button>
                      </SheetTrigger>
                      <SheetContent>
                        <SheetHeader>
                          <SheetTitle>{tHardcodedUi.raw('appHomeDesignSystemPage.line1509JsxTextSheetTitle')}</SheetTitle>
                          <SheetDescription>{tHardcodedUi.raw('appHomeDesignSystemPage.line1511JsxTextASidePanelForSecondaryContentAndActions')}</SheetDescription>
                        </SheetHeader>
                        <div className="py-6">
                          <p className="text-sm text-muted-foreground">{tHardcodedUi.raw('appHomeDesignSystemPage.line1516JsxTextSheetBodyContent')}</p>
                        </div>
                      </SheetContent>
                    </Sheet>
                  </DemoContainer>
                </div>

                {/* ─── Dropdown Menu ─── */}
                <div id="comp-dropdown" className="mb-12">
                  <ComponentLabel>{tHardcodedUi.raw('appHomeDesignSystemPage.line1526JsxTextDropdownMenu')}</ComponentLabel>
                  <ComponentDesc>{tHardcodedUi.raw('appHomeDesignSystemPage.line1528JsxTextContextualMenuTriggeredByAButtonRowsStay')}{' '}
                    <strong>neutral</strong>{tHardcodedUi.raw('appHomeDesignSystemPage.line1529JsxTextEvenDestructiveOnesLikeDeleteOrRemoveRed')}</ComponentDesc>
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
                        <DropdownMenuItem>Delete</DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </DemoContainer>
                </div>

                {/* ─── Tooltip ─── */}
                <div id="comp-tooltip" className="mb-12">
                  <ComponentLabel>Tooltip</ComponentLabel>
                  <ComponentDesc>{tHardcodedUi.raw('appHomeDesignSystemPage.line1558JsxTextContextualInformationOnHover')}</ComponentDesc>
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
                            <p>{tHardcodedUi.raw('appHomeDesignSystemPage.line1570JsxTextThisIsAHelpfulTooltip')}</p>
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
                  <ComponentDesc>{tHardcodedUi.raw('appHomeDesignSystemPage.line1598JsxTextFloatingContentPanelAttachedToATrigger')}</ComponentDesc>
                  <DemoContainer>
                    <Popover>
                      <PopoverTrigger asChild>
                        <Button variant="outline">{tHardcodedUi.raw('appHomeDesignSystemPage.line1603JsxTextOpenPopover')}</Button>
                      </PopoverTrigger>
                      <PopoverContent className="w-64">
                        <div className="space-y-2">
                          <p className="text-sm font-medium">{tHardcodedUi.raw('appHomeDesignSystemPage.line1607JsxTextPopoverTitle')}</p>
                          <p className="text-xs text-muted-foreground">{tHardcodedUi.raw('appHomeDesignSystemPage.line1609JsxTextThisIsThePopoverContentItCanContain')}</p>
                        </div>
                      </PopoverContent>
                    </Popover>
                  </DemoContainer>
                </div>

                {/* ─── Alert ─── */}
                <div id="comp-alert" className="mb-12">
                  <ComponentLabel>Alert</ComponentLabel>
                  <ComponentDesc>{tHardcodedUi.raw('appHomeDesignSystemPage.line1622JsxTextInlineNotificationWithContextualVariants')}</ComponentDesc>
                  <DemoContainer>
                    <div className="space-y-3">
                      <Alert>
                        <Info className="size-4" />
                        <AlertTitle>{tHardcodedUi.raw('appHomeDesignSystemPage.line1628JsxTextDefaultAlert')}</AlertTitle>
                        <AlertDescription>{tHardcodedUi.raw('appHomeDesignSystemPage.line1630JsxTextThisIsADefaultInformationalAlert')}</AlertDescription>
                      </Alert>
                      <Alert variant="destructive">
                        <AlertCircle className="size-4" />
                        <AlertTitle>Destructive</AlertTitle>
                        <AlertDescription>{tHardcodedUi.raw('appHomeDesignSystemPage.line1637JsxTextSomethingWentWrongPleaseTryAgain')}</AlertDescription>
                      </Alert>
                      <Alert variant="warning">
                        <TriangleAlert className="size-4" />
                        <AlertTitle>Warning</AlertTitle>
                        <AlertDescription>{tHardcodedUi.raw('appHomeDesignSystemPage.line1644JsxTextThisActionMayHaveUnintendedConsequences')}</AlertDescription>
                      </Alert>
                    </div>
                  </DemoContainer>
                </div>

                {/* ─── Alert Dialog ─── */}
                <div id="comp-alert-dialog" className="mb-12">
                  <ComponentLabel>{tHardcodedUi.raw('appHomeDesignSystemPage.line1653JsxTextAlertDialog')}</ComponentLabel>
                  <ComponentDesc>{tHardcodedUi.raw('appHomeDesignSystemPage.line1655JsxTextConfirmationDialogForDestructiveOrImportantActions')}</ComponentDesc>
                  <DemoContainer>
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button variant="destructive">{tHardcodedUi.raw('appHomeDesignSystemPage.line1660JsxTextDeleteItem')}</Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>{tHardcodedUi.raw('appHomeDesignSystemPage.line1665JsxTextAreYouSure')}</AlertDialogTitle>
                          <AlertDialogDescription>{tHardcodedUi.raw('appHomeDesignSystemPage.line1668JsxTextThisActionCannotBeUndoneThisWillPermanently')}</AlertDialogDescription>
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
                  <ComponentDesc>{tHardcodedUi.raw('appHomeDesignSystemPage.line1685JsxTextCollapsibleContentSectionsWithSmoothAnimation')}</ComponentDesc>
                  <DemoContainer>
                    <Accordion type="single" collapsible className="w-full">
                      <AccordionItem value="item-1">
                        <AccordionTrigger>{tHardcodedUi.raw('appHomeDesignSystemPage.line1691JsxTextWhatIsKortix')}</AccordionTrigger>
                        <AccordionContent>{tHardcodedUi.raw('appHomeDesignSystemPage.line1694JsxTextKortixIsAnAiPoweredPlatformForBuilding')}</AccordionContent>
                      </AccordionItem>
                      <AccordionItem value="item-2">
                        <AccordionTrigger>{tHardcodedUi.raw('appHomeDesignSystemPage.line1702JsxTextWhatDesignSystemDoesItUse')}</AccordionTrigger>
                        <AccordionContent>{tHardcodedUi.raw('appHomeDesignSystemPage.line1705JsxTextKortixUsesAMonochromaticDesignSystemWithStrategic')}</AccordionContent>
                      </AccordionItem>
                      <AccordionItem value="item-3">
                        <AccordionTrigger>{tHardcodedUi.raw('appHomeDesignSystemPage.line1712JsxTextHowDoThemesWork')}</AccordionTrigger>
                        <AccordionContent>{tHardcodedUi.raw('appHomeDesignSystemPage.line1715JsxTextEachThemeDefinesASingleAccentHueApplied')}</AccordionContent>
                      </AccordionItem>
                    </Accordion>
                  </DemoContainer>
                </div>

                {/* ─── Collapsible ─── */}
                <div id="comp-collapsible" className="mb-12">
                  <ComponentLabel>Collapsible</ComponentLabel>
                  <ComponentDesc>{tHardcodedUi.raw('appHomeDesignSystemPage.line1730JsxTextASimplerExpandCollapsePrimitiveUnlikeAccordionIt')}</ComponentDesc>
                  <DemoContainer>
                    <Collapsible
                      open={collapsibleOpen}
                      onOpenChange={setCollapsibleOpen}
                      className="w-full"
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-medium">{tHardcodedUi.raw('appHomeDesignSystemPage.line1741JsxTextText3TaggedItems')}</span>
                        <CollapsibleTrigger asChild>
                          <Button variant="ghost" size="sm">
                            <ChevronsUpDown className="size-4" />
                            <span className="sr-only">Toggle</span>
                          </Button>
                        </CollapsibleTrigger>
                      </div>
                      <div className="rounded-2xl border border-border/50 px-4 py-2 mt-2 text-sm">{tHardcodedUi.raw('appHomeDesignSystemPage.line1751JsxTextKortixDesignSystem')}</div>
                      <CollapsibleContent className="mt-2 space-y-2">
                        <div className="rounded-2xl border border-border/50 px-4 py-2 text-sm">{tHardcodedUi.raw('appHomeDesignSystemPage.line1755JsxTextKortixComponents')}</div>
                        <div className="rounded-2xl border border-border/50 px-4 py-2 text-sm">{tHardcodedUi.raw('appHomeDesignSystemPage.line1758JsxTextKortixTokens')}</div>
                      </CollapsibleContent>
                    </Collapsible>
                  </DemoContainer>
                </div>

                {/* ─── Separator ─── */}
                <div id="comp-separator" className="mb-12">
                  <ComponentLabel>Separator</ComponentLabel>
                  <ComponentDesc>{tHardcodedUi.raw('appHomeDesignSystemPage.line1769JsxTextVisualDividerBetweenContentSections')}</ComponentDesc>
                  <DemoContainer>
                    <div className="space-y-4">
                      <p className="text-sm text-muted-foreground">{tHardcodedUi.raw('appHomeDesignSystemPage.line1774JsxTextContentAbove')}</p>
                      <Separator />
                      <p className="text-sm text-muted-foreground">{tHardcodedUi.raw('appHomeDesignSystemPage.line1778JsxTextContentBelow')}</p>
                    </div>
                  </DemoContainer>
                </div>

                {/* ─── Skeleton ─── */}
                <div id="comp-skeleton" className="mb-12">
                  <ComponentLabel>Skeleton</ComponentLabel>
                  <ComponentDesc>{tHardcodedUi.raw('appHomeDesignSystemPage.line1788JsxTextLoadingPlaceholderForContentThatHasn')}{"'"}{tHardcodedUi.raw('appHomeDesignSystemPage.line1788JsxTextTLoadedYet')}</ComponentDesc>
                  <DemoContainer>
                    <div className="space-y-6">
                      {/* Card-like skeleton */}
                      <div>
                        <p className="text-xs text-muted-foreground mb-3">{tHardcodedUi.raw('appHomeDesignSystemPage.line1795JsxTextCardSkeleton')}</p>
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
                        <p className="text-xs text-muted-foreground mb-3">{tHardcodedUi.raw('appHomeDesignSystemPage.line1809JsxTextInlineVariants')}</p>
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
                  <ComponentDesc>{tHardcodedUi.raw('appHomeDesignSystemPage.line1828JsxTextVisualIndicatorOfCompletionOrLoading')}</ComponentDesc>
                  <DemoContainer>
                    <div className="space-y-4">
                      {[0, 25, 50, 75, 100].map((v) => (
                        <div key={v} className="space-y-1.5">
                          <span className="text-xs font-mono text-muted-foreground">
                            {v}%
                          </span>
                          <Progress value={v} />
                        </div>
                      ))}
                    </div>
                  </DemoContainer>
                </div>

                {/* ─── Slider ─── */}
                <div id="comp-slider" className="mb-12">
                  <ComponentLabel>Slider</ComponentLabel>
                  <ComponentDesc>{tHardcodedUi.raw('appHomeDesignSystemPage.line1848JsxTextRangeInputForSelectingNumericValues')}</ComponentDesc>
                  <DemoContainer>
                    <div className="max-w-sm space-y-4">
                      <Slider
                        value={sliderValue}
                        onValueChange={setSliderValue}
                        max={100}
                        step={1}
                      />
                      <span className="text-xs font-mono text-muted-foreground">
                        Value: {sliderValue[0]}
                      </span>
                    </div>
                  </DemoContainer>
                </div>

                {/* ─── Label ─── */}
                <div id="comp-label" className="mb-12">
                  <ComponentLabel>Label</ComponentLabel>
                  <ComponentDesc>{tHardcodedUi.raw('appHomeDesignSystemPage.line1869JsxTextAccessibleLabelForFormControls')}</ComponentDesc>
                  <DemoContainer>
                    <div className="max-w-sm space-y-2">
                      <Label htmlFor="label-demo">{tHardcodedUi.raw('appHomeDesignSystemPage.line1873JsxTextEmailAddress')}</Label>
                      <Input
                        id="label-demo"
                        type="email"
                        placeholder={tHardcodedUi.raw('appHomeDesignSystemPage.line1877JsxAttrPlaceholderYouExampleCom')}
                      />
                    </div>
                  </DemoContainer>
                </div>

                {/* ─── Breadcrumb ─── */}
                <div id="comp-breadcrumb" className="mb-12">
                  <ComponentLabel>Breadcrumb</ComponentLabel>
                  <ComponentDesc>{tHardcodedUi.raw('appHomeDesignSystemPage.line1887JsxTextNavigationHierarchyTrail')}</ComponentDesc>
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
                          <BreadcrumbPage>{tHardcodedUi.raw('appHomeDesignSystemPage.line1901JsxTextDesignSystem')}</BreadcrumbPage>
                        </BreadcrumbItem>
                      </BreadcrumbList>
                    </Breadcrumb>
                  </DemoContainer>
                </div>

                {/* ─── Table ─── */}
                <div id="comp-table" className="mb-12">
                  <ComponentLabel>Table</ComponentLabel>
                  <ComponentDesc>{tHardcodedUi.raw('appHomeDesignSystemPage.line1912JsxTextStructuredDataDisplayInRowsAndColumns')}</ComponentDesc>
                  <DemoContainer className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Component</TableHead>
                          <TableHead>Variants</TableHead>
                          <TableHead>Status</TableHead>
                          <TableHead className="text-right">
                            Instances
                          </TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        <TableRow>
                          <TableCell className="font-medium">Button</TableCell>
                          <TableCell>6</TableCell>
                          <TableCell>
                            <Badge variant="new" className="text-xs">Stable</Badge>
                          </TableCell>
                          <TableCell className="text-right">624</TableCell>
                        </TableRow>
                        <TableRow>
                          <TableCell className="font-medium">Badge</TableCell>
                          <TableCell>7</TableCell>
                          <TableCell>
                            <Badge variant="new" className="text-xs">Stable</Badge>
                          </TableCell>
                          <TableCell className="text-right">189</TableCell>
                        </TableRow>
                        <TableRow>
                          <TableCell className="font-medium">Card</TableCell>
                          <TableCell>2</TableCell>
                          <TableCell>
                            <Badge variant="new" className="text-xs">Stable</Badge>
                          </TableCell>
                          <TableCell className="text-right">312</TableCell>
                        </TableRow>
                        <TableRow>
                          <TableCell className="font-medium">Input</TableCell>
                          <TableCell>1</TableCell>
                          <TableCell>
                            <Badge variant="beta" className="text-xs">Enhancing</Badge>
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
                  <ComponentDesc>{tHardcodedUi.raw('appHomeDesignSystemPage.line1968JsxTextKeyboardShortcutIndicatorsThemeAwareIncludingAutomaticStyling')}</ComponentDesc>
                  <DemoContainer>
                    <div className="space-y-4">
                      <div>
                        <p className="text-xs text-muted-foreground mb-3">{tHardcodedUi.raw('appHomeDesignSystemPage.line1975JsxTextIndividualKeys')}</p>
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
                        <p className="text-xs text-muted-foreground mb-3">{tHardcodedUi.raw('appHomeDesignSystemPage.line1988JsxTextKeyGroupsShortcuts')}</p>
                        <div className="flex flex-wrap items-center gap-4">
                          <KbdGroup>
                            <Kbd>⌘</Kbd>
                            <span className="text-muted-foreground text-xs">
                              +
                            </span>
                            <Kbd>K</Kbd>
                          </KbdGroup>
                          <KbdGroup>
                            <Kbd>⌘</Kbd>
                            <span className="text-muted-foreground text-xs">
                              +
                            </span>
                            <Kbd>Shift</Kbd>
                            <span className="text-muted-foreground text-xs">
                              +
                            </span>
                            <Kbd>P</Kbd>
                          </KbdGroup>
                          <KbdGroup>
                            <Kbd>Ctrl</Kbd>
                            <span className="text-muted-foreground text-xs">
                              +
                            </span>
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
                  <ComponentDesc>{tHardcodedUi.raw('appHomeDesignSystemPage.line2026JsxTextDatePickerCalendarGrid')}</ComponentDesc>
                  <DemoContainer>
                    <Calendar
                      mode="single"
                      selected={selectedDate}
                      onSelect={setSelectedDate}
                      className="rounded-lg border border-border/50"
                    />
                  </DemoContainer>
                </div>

                {/* ─── Scroll Area ─── */}
                <div id="comp-scrollarea" className="mb-12">
                  <ComponentLabel>{tHardcodedUi.raw('appHomeDesignSystemPage.line2040JsxTextScrollArea')}</ComponentLabel>
                  <ComponentDesc>{tHardcodedUi.raw('appHomeDesignSystemPage.line2042JsxTextCustomScrollableContainerWithStyledScrollbar')}</ComponentDesc>
                  <DemoContainer>
                    <ScrollArea className="h-48 w-full rounded-2xl border border-border/50 p-4">
                      <div className="space-y-2">
                        {Array.from({ length: 20 }, (_, i) => (
                          <div
                            key={i}
                            className="flex items-center gap-3 py-1.5 border-b border-border/20"
                          >
                            <span className="text-xs font-mono text-muted-foreground w-6">
                              {String(i + 1).padStart(2, '0')}
                            </span>
                            <span className="text-sm text-foreground">{tHardcodedUi.raw('appHomeDesignSystemPage.line2056JsxTextListItem')}{' '}{i + 1}
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
              <h2 className="text-xs uppercase tracking-widest text-muted-foreground mb-5">{tHardcodedUi.raw('appHomeDesignSystemPage.line2070JsxTextPagePatterns')}</h2>
              <p className="text-base text-muted-foreground leading-relaxed mb-8">{tHardcodedUi.raw('appHomeDesignSystemPage.line2073JsxTextHowKortixListManagementPagesAreBuiltThese')}<code className="text-xs font-mono">/scheduled-tasks</code>,{' '}
                <code className="text-xs font-mono">/tunnel</code>{tHardcodedUi.raw('appHomeDesignSystemPage.line2075JsxTextNewManagementStylePagesShouldComposeTheSame')}</p>

              {/* ── PageHeader ── */}
              <div id="pat-page-header" className="mb-12">
                <ComponentLabel>PageHeader</ComponentLabel>
                <ComponentDesc>{tHardcodedUi.raw('appHomeDesignSystemPage.line2084JsxTextTheCanonicalHeroForListManagementPagesRounded')}<code className="text-xs font-mono">max-w-7xl</code>{tHardcodedUi.raw('appHomeDesignSystemPage.line2087JsxTextHorizontalPadding')}</ComponentDesc>
                <DemoContainer className="p-0 overflow-hidden">
                  <div className="p-6">
                    <PageHeader icon={Zap}>
                      <div className="space-y-2 sm:space-y-4">
                        <div className="text-2xl sm:text-3xl md:text-4xl font-semibold tracking-tight">
                          <span className="text-primary">{tHardcodedUi.raw('appHomeDesignSystemPage.line2094JsxTextScheduledTasks')}</span>
                        </div>
                      </div>
                    </PageHeader>
                  </div>
                </DemoContainer>
                <pre className="mt-3 text-xs font-mono text-muted-foreground bg-muted/20 rounded-lg px-4 py-3 overflow-x-auto">{`<div className="container mx-auto max-w-7xl px-3 sm:px-4 py-3 sm:py-4">
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
                <ComponentDesc>{tHardcodedUi.raw('appHomeDesignSystemPage.line2113JsxTextItemCardUsedAcrossEveryListPageMouse')}<code className="text-xs font-mono">{tHardcodedUi.raw('appHomeDesignSystemPage.line2115JsxTextBgCardBorderBorderBorder50')}</code>{tHardcodedUi.raw('appHomeDesignSystemPage.line2115JsxTextAndApplyYourOwnInnerPadding')}</ComponentDesc>
                <DemoContainer>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    {[
                      { icon: Cable, label: 'tunnel-42', sub: 'exposes :3000' },
                      { icon: Radio, label: '#releases', sub: 'Slack channel' },
                      { icon: Zap, label: 'nightly-cron', sub: 'every day at 03:00' },
                      { icon: Plug, label: 'GitHub', sub: 'Connected' },
                    ].map((item, i) => {
                      const I = item.icon;
                      return (
                        <SpotlightCard
                          key={i}
                          className="bg-card border border-border/50"
                        >
                          <div className="p-4 flex items-center gap-3 cursor-pointer">
                            <div className="flex items-center justify-center w-9 h-9 rounded-[10px] bg-muted border border-border/50 shrink-0">
                              <I className="h-4 w-4 text-foreground" />
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="text-sm font-semibold text-foreground truncate">
                                {item.label}
                              </div>
                              <div className="text-xs text-muted-foreground truncate">
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
                <ComponentDesc>{tHardcodedUi.raw('appHomeDesignSystemPage.line2156JsxTextStandardSearchPillPlacedInTheActionBar')}<code className="text-xs font-mono">max-w-md</code>{tHardcodedUi.raw('appHomeDesignSystemPage.line2157JsxTextWidthSoItSitsNextToARight')}</ComponentDesc>
                <DemoContainer>
                  <div className="flex items-center justify-between gap-4">
                    <PageSearchBar
                      value=""
                      onChange={() => {}}
                      placeholder={tHardcodedUi.raw('appHomeDesignSystemPage.line2166JsxAttrPlaceholderSearchConnections')}
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
                <ComponentLabel>{tHardcodedUi.raw('appHomeDesignSystemPage.line2179JsxTextStaggerMount')}</ComponentLabel>
                <ComponentDesc>{tHardcodedUi.raw('appHomeDesignSystemPage.line2181JsxTextEveryManagementPageMountsItsThreeZonesWith')}<code className="text-xs font-mono">delay-75</code>{tHardcodedUi.raw('appHomeDesignSystemPage.line2183JsxTextContentAt')}<code className="text-xs font-mono">delay-150</code>.
                </ComponentDesc>
                <DemoContainer>
                  <pre className="text-xs font-mono text-muted-foreground bg-muted/20 rounded-lg px-4 py-3 overflow-x-auto leading-relaxed">{`// Page header
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
              <h2 className="text-xs uppercase tracking-widest text-muted-foreground mb-5">
                Primitives
              </h2>
              <p className="text-base text-muted-foreground leading-relaxed mb-8">{tHardcodedUi.raw('appHomeDesignSystemPage.line2205JsxTextSmallCompositionPiecesUsedInsideProjectPagesIssue')}</p>

              {/* ── PageShell ── */}
              <div id="pat-page-shell" className="mb-12">
                <ComponentLabel>PageShell</ComponentLabel>
                <ComponentDesc>{tHardcodedUi.raw('appHomeDesignSystemPage.line2214JsxTextTheOneLayoutWrapperStandardisesMaxWidthHorizontal')}{' '}
                  <code className="text-xs font-mono">{tHardcodedUi.raw('appHomeDesignSystemPage.line2216JsxTextReading720')}</code>,{' '}
                  <code className="text-xs font-mono">{tHardcodedUi.raw('appHomeDesignSystemPage.line2217JsxTextDefault1000')}</code>,{' '}
                  <code className="text-xs font-mono">{tHardcodedUi.raw('appHomeDesignSystemPage.line2218JsxTextWide1280')}</code>,{' '}
                  <code className="text-xs font-mono">full</code>.
                </ComponentDesc>
                <DemoContainer>
                  <div className="rounded-2xl border border-dashed border-border/60 py-10 text-center text-xs text-muted-foreground">
                    <code>{tHardcodedUi.raw('appHomeDesignSystemPage.line2223JsxTextLtPageshellWidthQuotDefaultQuotGtLt')}</code>
                    <div className="mt-1 opacity-60">{tHardcodedUi.raw('appHomeDesignSystemPage.line2224JsxTextMaxW1000pxPx6LgPx10')}</div>
                  </div>
                </DemoContainer>
              </div>

              {/* ── Section ── */}
              <div id="pat-section" className="mb-12">
                <ComponentLabel>Section</ComponentLabel>
                <ComponentDesc>{tHardcodedUi.raw('appHomeDesignSystemPage.line2233JsxTextLabelledSectionInsideAPageshellUppercaseMicroLabel')}</ComponentDesc>
                <DemoContainer>
                  <BrandSection label="About">
                    <p className="text-sm text-foreground leading-relaxed">{tHardcodedUi.raw('appHomeDesignSystemPage.line2241JsxTextDescriptionContentLivesHereSectionsSeparateConcernsOn')}</p>
                  </BrandSection>
                  <BrandSection
                    label="Details"
                    action={
                      <Button variant="ghost" size="sm" className="h-6 px-2 text-xs">
                        Edit
                      </Button>
                    }
                  >
                    <p className="text-sm text-muted-foreground">{tHardcodedUi.raw('appHomeDesignSystemPage.line2254JsxTextASecondSectionWithATrailingAction')}</p>
                  </BrandSection>
                </DemoContainer>
              </div>

              {/* ── SectionCard ── */}
              <div id="pat-section-card" className="mb-12">
                <ComponentLabel>SectionCard</ComponentLabel>
                <ComponentDesc>{tHardcodedUi.raw('appHomeDesignSystemPage.line2264JsxTextTheOnePanelPatternComposesTheDesignSystem')}<code>flush</code>{tHardcodedUi.raw('appHomeDesignSystemPage.line2267JsxTextToSeatAListEdgeToEdgeAnd')}{' '}
                  <code>{tHardcodedUi.raw('appHomeDesignSystemPage.line2268JsxTextToneQuotDestructiveQuot')}</code>{tHardcodedUi.raw('appHomeDesignSystemPage.line2268JsxTextForDangerZonesNoSeparateComponentADanger')}<strong>neutral</strong>{tHardcodedUi.raw('appHomeDesignSystemPage.line2270JsxTextTriggerRedIsTheBrakeNotThePaint')}</ComponentDesc>
                <DemoContainer className="space-y-4">
                  <SectionCard
                    title="Members"
                    count={2}
                    description={tHardcodedUi.raw('appHomeDesignSystemPage.line2278JsxAttrDescriptionPeopleWithAccessToThisAccount')}
                    action={
                      <Button size="sm" className="h-8 px-3 text-sm">
                        Invite
                      </Button>
                    }
                  >
                    <p className="text-sm text-muted-foreground">{tHardcodedUi.raw('appHomeDesignSystemPage.line2286JsxTextBodyContentSitsInThePaddedRegionPass')}{' '}
                      <code>flush</code>{tHardcodedUi.raw('appHomeDesignSystemPage.line2287JsxTextToDropThePaddingForAList')}</p>
                  </SectionCard>
                  <SectionCard
                    tone="destructive"
                    title={tHardcodedUi.raw('appHomeDesignSystemPage.line2292JsxAttrTitleDangerZone')}
                    description={tHardcodedUi.raw('appHomeDesignSystemPage.line2293JsxAttrDescriptionIrreversibleActionsLiveHere')}
                  >
                    <div className="flex items-center justify-between gap-4">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-foreground">{tHardcodedUi.raw('appHomeDesignSystemPage.line2298JsxTextDeleteThisAccount')}</p>
                        <p className="mt-0.5 text-xs text-muted-foreground">{tHardcodedUi.raw('appHomeDesignSystemPage.line2301JsxTextPermanentlyRemovesTheAccountAndAllItsData')}</p>
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
                <ComponentDesc>{tHardcodedUi.raw('appHomeDesignSystemPage.line2316JsxTextOneRule')}<strong>{tHardcodedUi.raw('appHomeDesignSystemPage.line2316JsxTextPeopleAreRoundThingsAreSquare')}</strong>.{' '}
                  <code>UserAvatar</code>{tHardcodedUi.raw('appHomeDesignSystemPage.line2317JsxTextRendersACircularAvatarForAPersonThe')}{' '}
                  <strong>{tHardcodedUi.raw('appHomeDesignSystemPage.line2319JsxTextNeutralMonochromeInitials')}</strong>{tHardcodedUi.raw('appHomeDesignSystemPage.line2319JsxTextNoColouredBackgrounds')}<code>EntityAvatar</code>{tHardcodedUi.raw('appHomeDesignSystemPage.line2320JsxTextRendersARoundedSquareTileForAccountsProjects')}</ComponentDesc>
                <DemoContainer className="space-y-5">
                  <div className="flex items-center gap-4">
                    <span className="w-24 text-xs uppercase tracking-wider text-muted-foreground">
                      People
                    </span>
                    <UserAvatar email={tHardcodedUi.raw('appHomeDesignSystemPage.line2330JsxAttrEmailAdaKortixAi')} name="Ada Lovelace" size="sm" />
                    <UserAvatar email={tHardcodedUi.raw('appHomeDesignSystemPage.line2331JsxAttrEmailGraceKortixAi')} name="Grace Hopper" />
                    <UserAvatar email={tHardcodedUi.raw('appHomeDesignSystemPage.line2332JsxAttrEmailAlanKortixAi')} name="Alan Turing" size="lg" />
                  </div>
                  <div className="flex items-center gap-4">
                    <span className="w-24 text-xs uppercase tracking-wider text-muted-foreground">
                      Things
                    </span>
                    <EntityAvatar label={tHardcodedUi.raw('appHomeDesignSystemPage.line2338JsxAttrLabelAcmeAgi')} size="sm" />
                    <EntityAvatar label="Kortix" />
                    <EntityAvatar icon={FolderGit2} />
                    <EntityAvatar icon={Users} size="lg" />
                  </div>
                </DemoContainer>
              </div>

              {/* ── List & ListRow ── */}
              <div id="pat-list" className="mb-12">
                <ComponentLabel>{tHardcodedUi.raw('appHomeDesignSystemPage.line2348JsxTextListAmpListrow')}</ComponentLabel>
                <ComponentDesc>{tHardcodedUi.raw('appHomeDesignSystemPage.line2350JsxTextTheStandardListADividerSeparated')}<code>List</code> of{' '}
                  <code>ListRow</code>{tHardcodedUi.raw('appHomeDesignSystemPage.line2351JsxTextSEachWithALeadingAvatarSlotUseravatar')}{' '}
                  <code>{tHardcodedUi.raw('appHomeDesignSystemPage.line2355JsxTextSectioncardFlush')}</code>.
                </ComponentDesc>
                <DemoContainer className="p-0">
                  <SectionCard title="Members" count={2} flush>
                    <List>
                      <ListRow
                        leading={<UserAvatar email={tHardcodedUi.raw('appHomeDesignSystemPage.line2361JsxAttrEmailGraceKortixAi')} name="Grace Hopper" />}
                        title={tHardcodedUi.raw('appHomeDesignSystemPage.line2362JsxAttrTitleGraceKortixAi')}
                        badges={
                          <Badge variant="outline" size="sm">
                            You
                          </Badge>
                        }
                        subtitle={
                          <InlineMeta>
                            <span>{tHardcodedUi.raw('appHomeDesignSystemPage.line2370JsxTextJoinedMar32026')}</span>
                            <span>{tHardcodedUi.raw('appHomeDesignSystemPage.line2371JsxTextText4Projects')}</span>
                          </InlineMeta>
                        }
                        trailing={
                          <Badge variant="outline" size="sm" className="border-foreground/30 text-foreground">
                            Owner
                          </Badge>
                        }
                      />
                      <ListRow
                        leading={<UserAvatar email={tHardcodedUi.raw('appHomeDesignSystemPage.line2381JsxAttrEmailAlanKortixAi')} name="Alan Turing" />}
                        title={tHardcodedUi.raw('appHomeDesignSystemPage.line2382JsxAttrTitleAlanKortixAi')}
                        subtitle={
                          <InlineMeta>
                            <span>{tHardcodedUi.raw('appHomeDesignSystemPage.line2385JsxTextJoinedApr12026')}</span>
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
                <ComponentDesc>{tHardcodedUi.raw('appHomeDesignSystemPage.line2403JsxTextKeyValuePairsFixedWidthLabelColumnSo')}</ComponentDesc>
                <DemoContainer>
                  <DefinitionList dividers>
                    <DefinitionRow label="Path">
                      <code className="text-xs font-mono text-foreground">
                        /workspace/jjk-domain-search
                      </code>
                    </DefinitionRow>
                    <DefinitionRow label="Created">{tHardcodedUi.raw('appHomeDesignSystemPage.line2413JsxTextText2DaysAgo')}</DefinitionRow>
                    <DefinitionRow label="Updated">
                      <span className="tabular-nums">{tHardcodedUi.raw('appHomeDesignSystemPage.line2415JsxTextText3mAgo')}</span>
                    </DefinitionRow>
                    <DefinitionRow label="Sessions">8</DefinitionRow>
                  </DefinitionList>
                </DemoContainer>
              </div>

              {/* ── InlineMeta ── */}
              <div id="pat-inline-meta" className="mb-12">
                <ComponentLabel>InlineMeta</ComponentLabel>
                <ComponentDesc>{tHardcodedUi.raw('appHomeDesignSystemPage.line2426JsxTextDotSeparatedFactsDropAnyNumberOfChildren')}</ComponentDesc>
                <DemoContainer>
                  <InlineMeta>
                    <span className="font-mono text-foreground">
                      /workspace/jjk
                    </span>
                    <span>{tHardcodedUi.raw('appHomeDesignSystemPage.line2435JsxTextText24Issues')}</span>
                    <span>{tHardcodedUi.raw('appHomeDesignSystemPage.line2436JsxTextCreated2dAgo')}</span>
                    <span>{tHardcodedUi.raw('appHomeDesignSystemPage.line2437JsxTextText8Sessions')}</span>
                  </InlineMeta>
                </DemoContainer>
              </div>

              {/* ── EmptyState ── */}
              <div id="pat-empty-state" className="mb-12">
                <ComponentLabel>EmptyState</ComponentLabel>
                <ComponentDesc>{tHardcodedUi.raw('appHomeDesignSystemPage.line2446JsxTextTheCalmTeachingMomentIconHeadlineOneLine')}</ComponentDesc>
                <DemoContainer className="p-0">
                  <EmptyState
                    icon={IconInbox}
                    title={tHardcodedUi.raw('appHomeDesignSystemPage.line2453JsxAttrTitleNoIssuesYet')}
                    description={tHardcodedUi.raw('appHomeDesignSystemPage.line2454JsxAttrDescriptionCreateYourFirstIssueWithCOrImport')}
                    action={
                      <Button size="sm" className="h-8 px-4 text-sm">{tHardcodedUi.raw('appHomeDesignSystemPage.line2457JsxTextNewIssue')}</Button>
                    }
                    secondaryAction={
                      <Button variant="ghost" size="sm" className="h-8 px-3 text-sm">{tHardcodedUi.raw('appHomeDesignSystemPage.line2462JsxTextLearnMore')}</Button>
                    }
                  />
                </DemoContainer>
              </div>

              {/* ── InfoBanner ── */}
              <div id="pat-info-banner" className="mb-12">
                <ComponentLabel>InfoBanner</ComponentLabel>
                <ComponentDesc>{tHardcodedUi.raw('appHomeDesignSystemPage.line2473JsxTextAnInlineStatusInfoNoticeManifestStatusA')}<code>tone</code>{tHardcodedUi.raw('appHomeDesignSystemPage.line2474JsxTextNeutralInfoSuccessWarningDestructiveInsteadOfHand')}</ComponentDesc>
                <DemoContainer className="space-y-3">
                  <InfoBanner tone="info" icon={Info} title={tHardcodedUi.raw('appHomeDesignSystemPage.line2479JsxAttrTitleHeadsUp')}>{tHardcodedUi.raw('appHomeDesignSystemPage.line2480JsxTextTheManifestIsBeingReSyncedSecretsApply')}</InfoBanner>
                  <InfoBanner tone="warning" icon={TriangleAlert} title={tHardcodedUi.raw('appHomeDesignSystemPage.line2482JsxAttrTitleEmailSkipped')}>{tHardcodedUi.raw('appHomeDesignSystemPage.line2483JsxTextMailtrapIsnAposTConfiguredLocallyCopyThe')}</InfoBanner>
                  <InfoBanner
                    tone="success"
                    icon={Check}
                    title={tHardcodedUi.raw('appHomeDesignSystemPage.line2488JsxAttrTitleAllSet')}
                    action={
                      <Button size="sm" variant="ghost" className="h-7 px-2 text-xs">
                        Dismiss
                      </Button>
                    }
                  >{tHardcodedUi.raw('appHomeDesignSystemPage.line2495JsxTextYourRepositoryIsConnected')}</InfoBanner>
                </DemoContainer>
              </div>

              <div id="pat-status" className="mb-12">
                <ComponentLabel>{tHardcodedUi.raw('appHomeDesignSystemPage.line2501JsxTextStatusDotBadgeAmpDiffstat')}</ComponentLabel>
                <ComponentDesc>{tHardcodedUi.raw('appHomeDesignSystemPage.line2503JsxTextTheSingleSourceOfTruthForLdquoThis')}{' '}
                  <code>Badge</code>{tHardcodedUi.raw('appHomeDesignSystemPage.line2505JsxTextBoxesUse')}<code>InfoBanner</code>{tHardcodedUi.raw('appHomeDesignSystemPage.line2505JsxTextForTheCasesAComponentCanAposT')}<code>StatusDot</code>
                  , <code>DiffStat</code>{tHardcodedUi.raw('appHomeDesignSystemPage.line2508JsxTextOrThe')}<code>STATUS_TEXT/BG/BORDER</code>{' '}{tHardcodedUi.raw('appHomeDesignSystemPage.line2509JsxTextMapsInsteadOfReInlining')}<code>text-emerald-500</code>.
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
                    <StatusBadge tone="success">{tHardcodedUi.raw('appHomeDesignSystemPage.line2535JsxTextText3Passed')}</StatusBadge>
                    <StatusBadge tone="warning">{tHardcodedUi.raw('appHomeDesignSystemPage.line2536JsxTextText5Warnings')}</StatusBadge>
                    <StatusBadge tone="destructive">{tHardcodedUi.raw('appHomeDesignSystemPage.line2537JsxTextText2Errors')}</StatusBadge>
                    <StatusBadge tone="info">Modified</StatusBadge>
                    <StatusBadge tone="neutral">Idle</StatusBadge>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Use <code>StatusBadge</code>{tHardcodedUi.raw('appHomeDesignSystemPage.line2542JsxTextForInformationalStatusFaintInclRed')}<code>{tHardcodedUi.raw('appHomeDesignSystemPage.line2543JsxTextBadgeVariantQuotDestructiveQuot')}</code>{' '}{tHardcodedUi.raw('appHomeDesignSystemPage.line2544JsxTextIsASolidRedPillReserveItFor')}</p>
                </DemoContainer>
              </div>
            </section>

            {/* ═══════════════ Anti-Patterns ═══════════════ */}
            <section id="anti-patterns">
              <SectionDivider />
                <h2 className="text-xs uppercase tracking-widest text-muted-foreground mb-5">
                  Anti-Patterns
                </h2>
                <p className="text-base text-muted-foreground leading-relaxed mb-8">{tHardcodedUi.raw('appHomeDesignSystemPage.line2557JsxTextCodePatternsThatViolateTheDesignSystemFollow')}</p>

                <div className="space-y-6">
                  <AntiPatternBlock
                    title={tHardcodedUi.raw('appHomeDesignSystemPage.line2564JsxAttrTitleAp1NoInlineStyleForFixedValues')}
                    description={tHardcodedUi.raw('appHomeDesignSystemPage.line2565JsxAttrDescriptionBypassesTheUtilitySystemCanTBePurged')}
                    bad={`<div style={{ height: '14px', overflow: 'hidden' }}>\n  Content\n</div>`}
                    good={`<div className="h-3.5 overflow-hidden">\n  Content\n</div>`}
                  />

                  <AntiPatternBlock
                    title={tHardcodedUi.raw('appHomeDesignSystemPage.line2571JsxAttrTitleAp2NoArbitraryTextSizes')}
                    description={tHardcodedUi.raw('appHomeDesignSystemPage.line2572JsxAttrDescriptionCreatesInconsistentTypeSizesWithNoSemanticMeaning')}
                    bad={
                      '<span className="text-' +
                      '[11px]">Label</span>\n<span className="text-' +
                      '[13.5px]">Meta</span>\n<span className="text-' +
                      '[0.875em]">Body</span>'
                    }
                    good={`<span className="text-xs">Label</span>\n<span className="text-xs">Meta</span>\n<span className="text-sm">Body</span>`}
                  />

                  <AntiPatternBlock
                    title={tHardcodedUi.raw('appHomeDesignSystemPage.line2583JsxAttrTitleAp3NoRawButtonElements')}
                    description={tHardcodedUi.raw('appHomeDesignSystemPage.line2584JsxAttrDescriptionRawButtonsBypassVariantSystemHaveInconsistentSizing')}
                    bad={`<button\n  className="px-3 py-1.5 rounded-lg\n    bg-neutral-100 hover:bg-neutral-200"\n  onClick={handleClick}\n>\n  Save\n</button>`}
                    good={`<Button\n  variant="secondary"\n  size="sm"\n  onClick={handleClick}\n>\n  Save\n</Button>`}
                  />

                  <AntiPatternBlock
                    title={tHardcodedUi.raw('appHomeDesignSystemPage.line2590JsxAttrTitleAp4NoTransitionColors')}
                    description={tHardcodedUi.raw('appHomeDesignSystemPage.line2591JsxAttrDescriptionAnimatesEveryCssPropertyIncludingWidthHeightPadding')}
                    bad={`<div className="transition-colors duration-200\n  hover:bg-accent">`}
                    good={`<div className="transition-colors\n  duration-moderate hover:bg-accent">`}
                  />

                  <AntiPatternBlock
                    title={tHardcodedUi.raw('appHomeDesignSystemPage.line2597JsxAttrTitleAp5NoHardcodedHexColors')}
                    description={tHardcodedUi.raw('appHomeDesignSystemPage.line2598JsxAttrDescriptionCompletelyBypassesTheThemeSystemWillLookWrong')}
                    bad={`<div className="text-emerald-500">\n  Success\n</div>\n<div style={{ color: '#3b82f6' }}>\n  Info\n</div>`}
                    good={`<div className="text-success">\n  Success\n</div>\n<div className="text-info">\n  Info\n</div>`}
                  />

                  <AntiPatternBlock
                    title={tHardcodedUi.raw('appHomeDesignSystemPage.line2604JsxAttrTitleAp6NoClickableDivElements')}
                    description={tHardcodedUi.raw('appHomeDesignSystemPage.line2605JsxAttrDescriptionNotKeyboardAccessibleNoFocusRingNotAnnounced')}
                    bad={`<div\n  onClick={handler}\n  className="cursor-pointer"\n>\n  Click me\n</div>`}
                    good={`<Button\n  variant="ghost"\n  onClick={handler}\n>\n  Click me\n</Button>`}
                  />
                </div>
            </section>

            {/* ═══════════════ Usage ═══════════════ */}
            <section id="usage">
              <SectionDivider />
                <h2 className="text-xs uppercase tracking-widest text-muted-foreground mb-5">
                  Usage
                </h2>

                <div className="grid md:grid-cols-2 gap-10">
                  <div>
                    <p className="text-xs text-emerald-600 dark:text-emerald-400 tracking-widest uppercase mb-4">
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
                        className="flex items-start gap-2.5 py-2 border-b border-border/30"
                      >
                        <span className="mt-0.5 flex items-center justify-center size-4 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 shrink-0">
                          <Check className="size-2.5" />
                        </span>
                        <span className="text-sm text-muted-foreground">
                          {t}
                        </span>
                      </div>
                    ))}
                  </div>
                  <div>
                    <p className="text-xs text-red-600 dark:text-red-400 tracking-widest uppercase mb-4">
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
                        className="flex items-start gap-2.5 py-2 border-b border-border/30"
                      >
                        <span className="mt-0.5 flex items-center justify-center size-4 rounded-full bg-red-500/10 text-red-600 dark:text-red-400 shrink-0">
                          <X className="size-2.5" />
                        </span>
                        <span className="text-sm text-muted-foreground">
                          {t}
                        </span>
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
