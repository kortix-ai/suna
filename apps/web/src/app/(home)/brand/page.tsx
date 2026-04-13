'use client';

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

const TYPE_SCALE = [
  { token: 'text-[10px]', size: '0.625rem', px: '~10px', twClass: 'text-[0.625rem]', use: 'Timestamps, metadata, badges' },
  { token: 'text-xs', size: '0.6875rem', px: '~11px', twClass: 'text-xs', use: 'Secondary labels, tooltips, KBD' },
  { token: 'text-sm', size: '0.8125rem', px: '~13px', twClass: 'text-sm', use: 'Body text, menu items' },
  { token: 'text-base', size: '0.875rem', px: '~14px', twClass: 'text-base', use: 'Default UI text, inputs' },
  { token: 'text-md', size: '0.9375rem', px: '~15px', twClass: 'text-[0.9375rem]', use: 'Card titles, emphasized body' },
  { token: 'text-lg', size: '1rem', px: '~16px', twClass: 'text-lg', use: 'Section headers, dialog titles' },
  { token: 'text-xl', size: '1.125rem', px: '~18px', twClass: 'text-xl', use: 'Page section titles' },
  { token: 'text-2xl', size: '1.25rem', px: '~20px', twClass: 'text-2xl', use: 'Page titles' },
  { token: 'text-3xl', size: '1.5rem', px: '~24px', twClass: 'text-3xl', use: 'Hero subheadings' },
  { token: 'text-4xl', size: '2rem', px: '~32px', twClass: 'text-4xl', use: 'Display / hero headings' },
  { token: 'text-5xl', size: '2.5rem', px: '~40px', twClass: 'text-5xl', use: 'Marketing display' },
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
    { id: 'pat-definition-list', label: 'DefinitionList' },
    { id: 'pat-inline-meta', label: 'InlineMeta' },
    { id: 'pat-empty-state', label: 'EmptyState' },
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
      <span className="font-mono text-[11px] text-muted-foreground group-hover:text-foreground transition-colors">
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
  const isWordmark = asset.label === 'Wordmark';
  const downloadHref = fmt === 'png' ? asset.pngSrc : asset.svgSrc;
  const downloadName = `kortix-${asset.label.toLowerCase()}-${asset.variant.toLowerCase()}.${fmt}`;

  return (
    <div className="group relative">
      <div
        className={cn(
          'aspect-[3/2] rounded-lg flex items-center justify-center transition-colors relative overflow-hidden',
          isWordmark ? 'px-6 py-8' : 'p-10',
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
            isWordmark
              ? 'max-h-8 md:max-h-10 w-full'
              : 'max-h-10 md:max-h-12 w-auto'
          )}
        />

        <a
          href={downloadHref}
          download={downloadName}
          className="absolute inset-0 flex items-center justify-center rounded-lg opacity-0 group-hover:opacity-100 transition-opacity bg-black/[0.04] dark:bg-white/[0.04] cursor-pointer"
        >
          <span className="flex items-center gap-1.5 text-[11px] font-medium bg-background ring-1 ring-border rounded-full px-3 py-1.5 shadow-sm">
            <Download className="size-3" /> {fmt.toUpperCase()}
          </span>
        </a>
      </div>

      <div className="mt-2 flex items-baseline gap-1.5 px-0.5">
        <span className="text-xs font-medium text-foreground">
          {asset.label}
        </span>
        <span className="text-[10px] font-mono text-muted-foreground">
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
            'text-[11px] font-mono px-3 py-1 rounded-full transition-colors cursor-pointer',
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
        'rounded-xl ring-1 ring-border/50 bg-card/30 p-6',
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
    <h3 className="text-[11px] uppercase tracking-widest text-muted-foreground mb-2">
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
        className="text-[11px] font-mono text-muted-foreground hover:text-foreground transition-colors cursor-pointer w-24 shrink-0 text-left"
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
      <span className="text-[10px] font-mono text-muted-foreground w-14 shrink-0 text-right">
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
            <span className="text-[10px] uppercase tracking-widest text-red-500/70 font-medium">
              Don&apos;t
            </span>
          </div>
          <pre className="text-xs font-mono text-muted-foreground whitespace-pre-wrap leading-relaxed bg-muted/30 rounded-lg p-3 overflow-x-auto">
            {bad}
          </pre>
        </div>
        <div className="p-4">
          <div className="flex items-center gap-1.5 mb-2.5">
            <Check className="size-3 text-emerald-500" />
            <span className="text-[10px] uppercase tracking-widest text-emerald-500/70 font-medium">
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
                  'text-[11px] block py-1 transition-colors',
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
                          'text-[10px] block py-0.5 transition-colors',
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
                  <Badge variant="outline" className="text-[10px] font-mono">
                    v1.0
                  </Badge>
                </div>
                <h1 className="text-3xl sm:text-4xl md:text-5xl font-medium tracking-tight text-foreground mb-5">
                  Brand &amp; Design System
                </h1>
                <p className="text-base text-muted-foreground leading-relaxed max-w-xl">
                  Logo assets, color palette, typography, motion tokens,
                  component library, and usage rules for building Kortix.
                  The complete reference for designers and engineers.
                </p>
                <div className="flex flex-wrap gap-2 mt-6">
                  <Badge variant="secondary">
                    <span className="font-mono">30+</span> Components
                  </Badge>
                  <Badge variant="secondary">
                    <span className="font-mono">7</span> Themes
                  </Badge>
                  <Badge variant="secondary">OKLCH Colors</Badge>
                  <Badge variant="secondary">Radix Primitives</Badge>
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
                <p className="text-base text-muted-foreground leading-relaxed mb-6">
                  Two forms — the symbol and the wordmark. Each in black and
                  white.
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {LOGO_ASSETS.map((a) => (
                    <LogoCard key={a.id} asset={a} fmt={logoFmt} />
                  ))}
                </div>
                <p className="text-sm text-muted-foreground leading-relaxed mt-6">
                  The symbol is derived from the letter K — connectivity and
                  intelligence abstracted into a geometric mark. Use it as a
                  favicon, app icon, or whenever the full wordmark isn{"'"}t
                  practical. Never stretch, rotate, or recolor it.
                </p>
            </section>

            {/* ═══════════════ Colors ═══════════════ */}
            <section id="colors">
              <SectionDivider />
                <h2 className="text-xs uppercase tracking-widest text-muted-foreground mb-5">
                  Colors
                </h2>
                <p className="text-base text-muted-foreground leading-relaxed mb-6">
                  Black and white is the foundation. Each UI theme pairs the
                  neutral base with exactly one accent color. The OKLCH color
                  space ensures perceptual uniformity across all themes.
                </p>

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
                    <p className="text-xs text-muted-foreground">
                      Core palette
                    </p>
                    <p className="font-mono text-[10px] text-muted-foreground/70">
                      globals.css · :root / .dark
                    </p>
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
                            <span className="absolute bottom-1 left-2 text-[9px] font-mono text-black/55 uppercase tracking-widest">
                              light
                            </span>
                          </div>
                          <div
                            className="relative ring-1 ring-inset ring-white/[0.06]"
                            style={{ backgroundColor: token.dark }}
                          >
                            <span className="absolute bottom-1 left-2 text-[9px] font-mono text-white/55 uppercase tracking-widest">
                              dark
                            </span>
                          </div>
                        </div>
                        <div className="px-3 py-2.5 bg-background">
                          <div className="flex items-baseline justify-between gap-2 mb-1">
                            <span className="text-xs font-medium text-foreground truncate">
                              {token.name}
                            </span>
                            <span className="font-mono text-[10px] text-muted-foreground shrink-0">
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
                <p className="text-base text-muted-foreground leading-relaxed mb-8">
                  Roobert — a geometric sans-serif. Font-medium (500) is the
                  brand weight. Roobert Mono for code and data.
                </p>

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
                      <span className="font-mono text-[10px] text-muted-foreground tracking-widest block mb-2">
                        {s.label}
                      </span>
                      <p
                        className={cn(
                          'text-3xl md:text-5xl tracking-tight text-foreground',
                          s.cls
                        )}
                      >
                        Kortix Computer
                      </p>
                    </div>
                  ))}
                </div>

                {/* Mono showcase */}
                <div className="bg-neutral-950 text-neutral-100 rounded-lg p-5 md:p-6 mt-6">
                  <span className="font-mono text-[10px] text-neutral-500 tracking-widest block mb-3">
                    Roobert Mono
                  </span>
                  <p className="font-mono text-lg md:text-2xl tracking-tight">
                    const agent = new Kortix();
                  </p>
                  <p className="font-mono text-[11px] text-neutral-600 mt-4">
                    ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz
                    0123456789
                  </p>
                </div>

                {/* Type scale table */}
                <div className="mt-8">
                  <p className="text-xs text-muted-foreground mb-4">
                    Type Scale
                  </p>
                  <div className="space-y-0">
                    {TYPE_SCALE.map((t) => (
                      <div
                        key={t.token}
                        className="flex items-baseline gap-4 py-3 border-b border-border/20"
                      >
                        <div className="w-24 shrink-0">
                          <span className="font-mono text-[10px] text-muted-foreground">
                            {t.token}
                          </span>
                        </div>
                        <div className="w-16 shrink-0">
                          <span className="font-mono text-[10px] text-muted-foreground">
                            {t.px}
                          </span>
                        </div>
                        <div className="flex-1 min-w-0">
                          <span
                            className="text-foreground font-medium truncate block"
                            style={{ fontSize: t.size }}
                          >
                            The quick brown fox
                          </span>
                        </div>
                        <div className="hidden sm:block shrink-0 max-w-48">
                          <span className="text-[10px] text-muted-foreground truncate block">
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
                <p className="text-base text-muted-foreground leading-relaxed mb-6">
                  Standardized duration and easing tokens ensure every
                  transition feels consistent. Click the labels to trigger the
                  animation.
                </p>

                {/* Duration scale */}
                <div className="mb-8">
                  <p className="text-xs text-muted-foreground mb-4">
                    Duration Scale
                  </p>
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
                  <p className="text-xs text-muted-foreground mb-4">
                    Easing Curves
                  </p>
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
                <p className="text-base text-muted-foreground leading-relaxed mb-6">
                  A consistent spacing scale based on 4px increments. Used for
                  padding, margins, and gaps throughout the UI.
                </p>

                <DemoContainer>
                  <div className="space-y-2.5">
                    {SPACING_SCALE.map((s) => (
                      <div key={s.token} className="flex items-center gap-4">
                        <span className="font-mono text-[10px] text-muted-foreground w-8 shrink-0 text-right">
                          {s.token}
                        </span>
                        <div
                          className="h-5 rounded-sm bg-foreground/60"
                          style={{ width: `${s.px * 3}px` }}
                        />
                        <span className="font-mono text-[10px] text-muted-foreground">
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
                <p className="text-base text-muted-foreground leading-relaxed mb-8">
                  The complete component library. Each component uses a
                  consistent API with variant and size props managed through
                  class-variance-authority. Built on Radix UI primitives for
                  accessibility and composability.
                </p>

                {/* ─── Button ─── */}
                <div id="comp-button" className="mb-12">
                  <ComponentLabel>Button</ComponentLabel>
                  <ComponentDesc>
                    10 variants × 8 sizes. The foundation of every interaction.
                    All sizes use <code className="font-mono text-[11px] bg-muted px-1 rounded">rounded-full</code> pill shape.
                    Containers (cards, inputs, dialogs) use <code className="font-mono text-[11px] bg-muted px-1 rounded">rounded-2xl</code>.
                  </ComponentDesc>
                  <DemoContainer>
                    <div className="space-y-6">
                      {/* Base Variants */}
                      <div>
                        <p className="text-[10px] text-muted-foreground mb-3 uppercase tracking-wider">Base Variants</p>
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
                        <p className="text-[10px] text-muted-foreground mb-3 uppercase tracking-wider">Kortix Variants</p>
                        <div className="flex flex-wrap gap-2">
                          <Button variant="subtle">Subtle</Button>
                          <Button variant="muted">Muted</Button>
                          <Button variant="inverse">Inverse</Button>
                          <Button variant="success">Success</Button>
                        </div>
                      </div>
                      {/* Standard Sizes */}
                      <div>
                        <p className="text-[10px] text-muted-foreground mb-3 uppercase tracking-wider">Standard Sizes</p>
                        <div className="flex flex-wrap items-center gap-2">
                          <Button size="lg">Large</Button>
                          <Button size="default">Default</Button>
                          <Button size="sm">Small</Button>
                          <Button size="icon"><Settings className="size-4" /></Button>
                        </div>
                      </div>
                      {/* Compact Sizes */}
                      <div>
                        <p className="text-[10px] text-muted-foreground mb-3 uppercase tracking-wider">Compact Sizes</p>
                        <div className="flex flex-wrap items-center gap-2">
                          <Button size="toolbar" variant="muted">Toolbar</Button>
                          <Button size="xs" variant="muted">XSmall</Button>
                          <Button size="icon-sm" variant="ghost"><Settings className="size-3.5" /></Button>
                          <Button size="icon-xs" variant="ghost"><X className="size-3" /></Button>
                        </div>
                      </div>
                      {/* With Icons */}
                      <div>
                        <p className="text-[10px] text-muted-foreground mb-3 uppercase tracking-wider">With Icons</p>
                        <div className="flex flex-wrap items-center gap-2">
                          <Button><Mail className="size-4" /> Send Email</Button>
                          <Button variant="outline"><Plus className="size-4" /> Create</Button>
                          <Button variant="subtle"><Search className="size-4" /> Search</Button>
                          <Button variant="destructive"><Trash2 className="size-4" /> Delete</Button>
                          <Button variant="inverse"><ArrowRight className="size-4" /> Launch</Button>
                          <Button variant="success" size="toolbar"><Check className="size-3.5" /> Confirm</Button>
                        </div>
                      </div>
                      {/* States */}
                      <div>
                        <p className="text-[10px] text-muted-foreground mb-3 uppercase tracking-wider">States</p>
                        <div className="flex flex-wrap items-center gap-2">
                          <Button disabled>Disabled</Button>
                          <Button disabled variant="outline">Disabled Outline</Button>
                          <Button><Loader2 className="size-4 animate-spin" /> Loading</Button>
                        </div>
                      </div>
                    </div>
                  </DemoContainer>
                </div>

                {/* ─── Badge ─── */}
                <div id="comp-badge" className="mb-12">
                  <ComponentLabel>Badge</ComponentLabel>
                  <ComponentDesc>
                    Labels, status indicators, and tags. Seven variants from
                    solid to subtle.
                  </ComponentDesc>
                  <DemoContainer>
                    <div className="space-y-4">
                      <div>
                        <p className="text-[10px] text-muted-foreground mb-3 uppercase tracking-wider">Base Variants</p>
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
                        <p className="text-[10px] text-muted-foreground mb-3 uppercase tracking-wider">Semantic Status</p>
                        <div className="flex flex-wrap gap-2">
                          <Badge variant="success">Success</Badge>
                          <Badge variant="warning">Warning</Badge>
                          <Badge variant="info">Info</Badge>
                          <Badge variant="muted">Muted</Badge>
                        </div>
                      </div>
                      <div>
                        <p className="text-[10px] text-muted-foreground mb-3 uppercase tracking-wider">Sizes</p>
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge variant="default">Default</Badge>
                          <Badge variant="default" size="sm">Small</Badge>
                          <Badge variant="success" size="sm">Active</Badge>
                          <Badge variant="warning" size="sm">Pending</Badge>
                        </div>
                      </div>
                      <div>
                        <p className="text-[10px] text-muted-foreground mb-3 uppercase tracking-wider">With Icons</p>
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
                  <ComponentDesc>
                    Container with header, content, and footer slots. Default
                    and glass (translucent, no blur) variants.
                  </ComponentDesc>
                  <DemoContainer>
                    <div className="grid sm:grid-cols-2 gap-4">
                      <Card variant="default">
                        <CardHeader>
                          <CardTitle>Default Card</CardTitle>
                          <CardDescription>
                            Standard card with solid background.
                          </CardDescription>
                        </CardHeader>
                        <CardContent>
                          <p className="text-sm text-muted-foreground">
                            Card content goes here. Use for grouping related
                            information.
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
                          <CardTitle>Glass Card</CardTitle>
                          <CardDescription>
                            Translucent surface for overlays and panels.
                          </CardDescription>
                        </CardHeader>
                        <CardContent>
                          <p className="text-sm text-muted-foreground">
                            Card content goes here. Used for overlays and
                            floating panels.
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
                    Text input for forms and search. Supports labels, placeholders,
                    and disabled state.
                  </ComponentDesc>
                  <DemoContainer>
                    <div className="space-y-4 max-w-sm">
                      <div className="space-y-2">
                        <Label htmlFor="demo-input">Label</Label>
                        <Input type="text"
                          id="demo-input"
                          placeholder="Default input"
                        />
                      </div>
                      <Input type="text" placeholder="With placeholder" />
                      <Input type="password" placeholder="Password input" />
                      <Input type="text" disabled placeholder="Disabled" />
                    </div>
                  </DemoContainer>
                </div>

                {/* ─── Textarea ─── */}
                <div id="comp-textarea" className="mb-12">
                  <ComponentLabel>Textarea</ComponentLabel>
                  <ComponentDesc>
                    Multi-line text input for longer content.
                  </ComponentDesc>
                  <DemoContainer>
                    <div className="space-y-4 max-w-sm">
                      <Textarea placeholder="Write something..." />
                      <Textarea disabled placeholder="Disabled textarea" />
                    </div>
                  </DemoContainer>
                </div>

                {/* ─── Select ─── */}
                <div id="comp-select" className="mb-12">
                  <ComponentLabel>Select</ComponentLabel>
                  <ComponentDesc>
                    Dropdown selection from a list of options.
                  </ComponentDesc>
                  <DemoContainer>
                    <div className="max-w-xs">
                      <Select>
                        <SelectTrigger>
                          <SelectValue placeholder="Select a framework" />
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
                    Toggle for boolean values.
                  </ComponentDesc>
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
                  <ComponentDesc>
                    Toggle control for on/off states.
                  </ComponentDesc>
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
                  <ComponentDesc>
                    A two-state button with default and outline variants.
                  </ComponentDesc>
                  <DemoContainer>
                    <div className="flex flex-wrap gap-2">
                      <Toggle
                        variant="default"
                        pressed={togglePressed}
                        onPressedChange={setTogglePressed}
                        aria-label="Toggle bold"
                      >
                        <Bold className="size-4" />
                      </Toggle>
                      <Toggle variant="outline" aria-label="Toggle settings">
                        <Settings className="size-4" />
                      </Toggle>
                    </div>
                  </DemoContainer>
                </div>

                {/* ─── Radio Group ─── */}
                <div id="comp-radio" className="mb-12">
                  <ComponentLabel>Radio Group</ComponentLabel>
                  <ComponentDesc>
                    Single selection from a set of options.
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
                    Tabbed navigation with standard and compact variants.
                  </ComponentDesc>
                  <DemoContainer>
                    <div className="space-y-6">
                      <div>
                        <p className="text-[10px] text-muted-foreground mb-3">
                          Standard
                        </p>
                        <Tabs defaultValue="tab1">
                          <TabsList>
                            <TabsTrigger value="tab1">Account</TabsTrigger>
                            <TabsTrigger value="tab2">Password</TabsTrigger>
                            <TabsTrigger value="tab3">Settings</TabsTrigger>
                          </TabsList>
                          <TabsContent value="tab1">
                            <p className="text-sm text-muted-foreground mt-2">
                              Account settings and preferences.
                            </p>
                          </TabsContent>
                          <TabsContent value="tab2">
                            <p className="text-sm text-muted-foreground mt-2">
                              Change your password.
                            </p>
                          </TabsContent>
                          <TabsContent value="tab3">
                            <p className="text-sm text-muted-foreground mt-2">
                              General settings.
                            </p>
                          </TabsContent>
                        </Tabs>
                      </div>
                      <div>
                        <p className="text-[10px] text-muted-foreground mb-3">
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
                            <p className="text-sm text-muted-foreground mt-2">
                              Daily view content.
                            </p>
                          </TabsContent>
                          <TabsContent value="c2">
                            <p className="text-sm text-muted-foreground mt-2">
                              Weekly view content.
                            </p>
                          </TabsContent>
                          <TabsContent value="c3">
                            <p className="text-sm text-muted-foreground mt-2">
                              Monthly view content.
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
                    Modal overlay for focused interactions.
                  </ComponentDesc>
                  <DemoContainer>
                    <Dialog>
                      <DialogTrigger asChild>
                        <Button variant="outline">Open Dialog</Button>
                      </DialogTrigger>
                      <DialogContent>
                        <DialogHeader>
                          <DialogTitle>Dialog Title</DialogTitle>
                          <DialogDescription>
                            This is a description of the dialog content. It
                            provides context for the user.
                          </DialogDescription>
                        </DialogHeader>
                        <div className="py-4">
                          <p className="text-sm text-muted-foreground">
                            Dialog body content goes here.
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

                {/* ─── Sheet ─── */}
                <div id="comp-sheet" className="mb-12">
                  <ComponentLabel>Sheet</ComponentLabel>
                  <ComponentDesc>
                    Slide-out panel from the edge of the viewport.
                  </ComponentDesc>
                  <DemoContainer>
                    <Sheet>
                      <SheetTrigger asChild>
                        <Button variant="outline">Open Sheet</Button>
                      </SheetTrigger>
                      <SheetContent>
                        <SheetHeader>
                          <SheetTitle>Sheet Title</SheetTitle>
                          <SheetDescription>
                            A side panel for secondary content and actions.
                          </SheetDescription>
                        </SheetHeader>
                        <div className="py-6">
                          <p className="text-sm text-muted-foreground">
                            Sheet body content.
                          </p>
                        </div>
                      </SheetContent>
                    </Sheet>
                  </DemoContainer>
                </div>

                {/* ─── Dropdown Menu ─── */}
                <div id="comp-dropdown" className="mb-12">
                  <ComponentLabel>Dropdown Menu</ComponentLabel>
                  <ComponentDesc>
                    Contextual menu triggered by a button.
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
                        <DropdownMenuItem className="text-destructive">
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </DemoContainer>
                </div>

                {/* ─── Tooltip ─── */}
                <div id="comp-tooltip" className="mb-12">
                  <ComponentLabel>Tooltip</ComponentLabel>
                  <ComponentDesc>
                    Contextual information on hover.
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
                            <p>This is a helpful tooltip</p>
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
                    Floating content panel attached to a trigger.
                  </ComponentDesc>
                  <DemoContainer>
                    <Popover>
                      <PopoverTrigger asChild>
                        <Button variant="outline">Open Popover</Button>
                      </PopoverTrigger>
                      <PopoverContent className="w-64">
                        <div className="space-y-2">
                          <p className="text-sm font-medium">Popover Title</p>
                          <p className="text-xs text-muted-foreground">
                            This is the popover content. It can contain any
                            elements.
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
                    Inline notification with contextual variants.
                  </ComponentDesc>
                  <DemoContainer>
                    <div className="space-y-3">
                      <Alert>
                        <Info className="size-4" />
                        <AlertTitle>Default Alert</AlertTitle>
                        <AlertDescription>
                          This is a default informational alert.
                        </AlertDescription>
                      </Alert>
                      <Alert variant="destructive">
                        <AlertCircle className="size-4" />
                        <AlertTitle>Destructive</AlertTitle>
                        <AlertDescription>
                          Something went wrong. Please try again.
                        </AlertDescription>
                      </Alert>
                      <Alert variant="warning">
                        <TriangleAlert className="size-4" />
                        <AlertTitle>Warning</AlertTitle>
                        <AlertDescription>
                          This action may have unintended consequences.
                        </AlertDescription>
                      </Alert>
                    </div>
                  </DemoContainer>
                </div>

                {/* ─── Alert Dialog ─── */}
                <div id="comp-alert-dialog" className="mb-12">
                  <ComponentLabel>Alert Dialog</ComponentLabel>
                  <ComponentDesc>
                    Confirmation dialog for destructive or important actions.
                  </ComponentDesc>
                  <DemoContainer>
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button variant="destructive">Delete Item</Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>
                            Are you sure?
                          </AlertDialogTitle>
                          <AlertDialogDescription>
                            This action cannot be undone. This will permanently
                            delete the item and remove all associated data.
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
                    Collapsible content sections with smooth animation.
                  </ComponentDesc>
                  <DemoContainer>
                    <Accordion type="single" collapsible className="w-full">
                      <AccordionItem value="item-1">
                        <AccordionTrigger>
                          What is Kortix?
                        </AccordionTrigger>
                        <AccordionContent>
                          Kortix is an AI-powered platform for building and
                          deploying intelligent agents. It provides the
                          infrastructure, tools, and interfaces needed to create
                          production-grade AI workflows.
                        </AccordionContent>
                      </AccordionItem>
                      <AccordionItem value="item-2">
                        <AccordionTrigger>
                          What design system does it use?
                        </AccordionTrigger>
                        <AccordionContent>
                          Kortix uses a monochromatic design system with
                          strategic accent colors, built on OKLCH color tokens,
                          the Roobert type family, and Radix UI primitives.
                        </AccordionContent>
                      </AccordionItem>
                      <AccordionItem value="item-3">
                        <AccordionTrigger>
                          How do themes work?
                        </AccordionTrigger>
                        <AccordionContent>
                          Each theme defines a single accent hue applied to
                          primary, ring, and chart tokens. All backgrounds,
                          surfaces, and borders remain neutral. Seven themes are
                          available: Graphite, Teal, Amber, Rose, Violet,
                          Emerald, and Neon.
                        </AccordionContent>
                      </AccordionItem>
                    </Accordion>
                  </DemoContainer>
                </div>

                {/* ─── Collapsible ─── */}
                <div id="comp-collapsible" className="mb-12">
                  <ComponentLabel>Collapsible</ComponentLabel>
                  <ComponentDesc>
                    A simpler expand/collapse primitive. Unlike Accordion, it
                    controls a single section without exclusive selection.
                  </ComponentDesc>
                  <DemoContainer>
                    <Collapsible
                      open={collapsibleOpen}
                      onOpenChange={setCollapsibleOpen}
                      className="w-full"
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-medium">
                          3 tagged items
                        </span>
                        <CollapsibleTrigger asChild>
                          <Button variant="ghost" size="sm">
                            <ChevronsUpDown className="size-4" />
                            <span className="sr-only">Toggle</span>
                          </Button>
                        </CollapsibleTrigger>
                      </div>
                      <div className="rounded-md border border-border/50 px-4 py-2 mt-2 text-sm">
                        @kortix/design-system
                      </div>
                      <CollapsibleContent className="mt-2 space-y-2">
                        <div className="rounded-md border border-border/50 px-4 py-2 text-sm">
                          @kortix/components
                        </div>
                        <div className="rounded-md border border-border/50 px-4 py-2 text-sm">
                          @kortix/tokens
                        </div>
                      </CollapsibleContent>
                    </Collapsible>
                  </DemoContainer>
                </div>

                {/* ─── Separator ─── */}
                <div id="comp-separator" className="mb-12">
                  <ComponentLabel>Separator</ComponentLabel>
                  <ComponentDesc>
                    Visual divider between content sections.
                  </ComponentDesc>
                  <DemoContainer>
                    <div className="space-y-4">
                      <p className="text-sm text-muted-foreground">
                        Content above
                      </p>
                      <Separator />
                      <p className="text-sm text-muted-foreground">
                        Content below
                      </p>
                    </div>
                  </DemoContainer>
                </div>

                {/* ─── Skeleton ─── */}
                <div id="comp-skeleton" className="mb-12">
                  <ComponentLabel>Skeleton</ComponentLabel>
                  <ComponentDesc>
                    Loading placeholder for content that hasn{"'"}t loaded yet.
                  </ComponentDesc>
                  <DemoContainer>
                    <div className="space-y-6">
                      {/* Card-like skeleton */}
                      <div>
                        <p className="text-[10px] text-muted-foreground mb-3">
                          Card Skeleton
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
                        <p className="text-[10px] text-muted-foreground mb-3">
                          Inline Variants
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
                    Visual indicator of completion or loading.
                  </ComponentDesc>
                  <DemoContainer>
                    <div className="space-y-4">
                      {[0, 25, 50, 75, 100].map((v) => (
                        <div key={v} className="space-y-1.5">
                          <span className="text-[10px] font-mono text-muted-foreground">
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
                  <ComponentDesc>
                    Range input for selecting numeric values.
                  </ComponentDesc>
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
                  <ComponentDesc>
                    Accessible label for form controls.
                  </ComponentDesc>
                  <DemoContainer>
                    <div className="max-w-sm space-y-2">
                      <Label htmlFor="label-demo">Email address</Label>
                      <Input
                        id="label-demo"
                        type="email"
                        placeholder="you@example.com"
                      />
                    </div>
                  </DemoContainer>
                </div>

                {/* ─── Breadcrumb ─── */}
                <div id="comp-breadcrumb" className="mb-12">
                  <ComponentLabel>Breadcrumb</ComponentLabel>
                  <ComponentDesc>
                    Navigation hierarchy trail.
                  </ComponentDesc>
                  <DemoContainer>
                    <Breadcrumb>
                      <BreadcrumbList>
                        <BreadcrumbItem>
                          <BreadcrumbLink href="#">Home</BreadcrumbLink>
                        </BreadcrumbItem>
                        <BreadcrumbSeparator />
                        <BreadcrumbItem>
                          <BreadcrumbLink href="#">Projects</BreadcrumbLink>
                        </BreadcrumbItem>
                        <BreadcrumbSeparator />
                        <BreadcrumbItem>
                          <BreadcrumbPage>Design System</BreadcrumbPage>
                        </BreadcrumbItem>
                      </BreadcrumbList>
                    </Breadcrumb>
                  </DemoContainer>
                </div>

                {/* ─── Table ─── */}
                <div id="comp-table" className="mb-12">
                  <ComponentLabel>Table</ComponentLabel>
                  <ComponentDesc>
                    Structured data display in rows and columns.
                  </ComponentDesc>
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
                            <Badge variant="new" className="text-[10px]">Stable</Badge>
                          </TableCell>
                          <TableCell className="text-right">624</TableCell>
                        </TableRow>
                        <TableRow>
                          <TableCell className="font-medium">Badge</TableCell>
                          <TableCell>7</TableCell>
                          <TableCell>
                            <Badge variant="new" className="text-[10px]">Stable</Badge>
                          </TableCell>
                          <TableCell className="text-right">189</TableCell>
                        </TableRow>
                        <TableRow>
                          <TableCell className="font-medium">Card</TableCell>
                          <TableCell>2</TableCell>
                          <TableCell>
                            <Badge variant="new" className="text-[10px]">Stable</Badge>
                          </TableCell>
                          <TableCell className="text-right">312</TableCell>
                        </TableRow>
                        <TableRow>
                          <TableCell className="font-medium">Input</TableCell>
                          <TableCell>1</TableCell>
                          <TableCell>
                            <Badge variant="beta" className="text-[10px]">Enhancing</Badge>
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
                    Keyboard shortcut indicators. Theme-aware, including
                    automatic styling when nested inside tooltips.
                  </ComponentDesc>
                  <DemoContainer>
                    <div className="space-y-4">
                      <div>
                        <p className="text-[10px] text-muted-foreground mb-3">
                          Individual Keys
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
                        <p className="text-[10px] text-muted-foreground mb-3">
                          Key Groups (Shortcuts)
                        </p>
                        <div className="flex flex-wrap items-center gap-4">
                          <KbdGroup>
                            <Kbd>⌘</Kbd>
                            <span className="text-muted-foreground text-[10px]">
                              +
                            </span>
                            <Kbd>K</Kbd>
                          </KbdGroup>
                          <KbdGroup>
                            <Kbd>⌘</Kbd>
                            <span className="text-muted-foreground text-[10px]">
                              +
                            </span>
                            <Kbd>Shift</Kbd>
                            <span className="text-muted-foreground text-[10px]">
                              +
                            </span>
                            <Kbd>P</Kbd>
                          </KbdGroup>
                          <KbdGroup>
                            <Kbd>Ctrl</Kbd>
                            <span className="text-muted-foreground text-[10px]">
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
                  <ComponentDesc>
                    Date picker calendar grid.
                  </ComponentDesc>
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
                  <ComponentLabel>Scroll Area</ComponentLabel>
                  <ComponentDesc>
                    Custom scrollable container with styled scrollbar.
                  </ComponentDesc>
                  <DemoContainer>
                    <ScrollArea className="h-48 w-full rounded-md border border-border/50 p-4">
                      <div className="space-y-2">
                        {Array.from({ length: 20 }, (_, i) => (
                          <div
                            key={i}
                            className="flex items-center gap-3 py-1.5 border-b border-border/20"
                          >
                            <span className="text-[10px] font-mono text-muted-foreground w-6">
                              {String(i + 1).padStart(2, '0')}
                            </span>
                            <span className="text-sm text-foreground">
                              List item {i + 1}
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
              <h2 className="text-xs uppercase tracking-widest text-muted-foreground mb-5">
                Page Patterns
              </h2>
              <p className="text-base text-muted-foreground leading-relaxed mb-8">
                How Kortix list / management pages are built. These are the
                shared chrome pieces used by <code className="text-[11px] font-mono">/scheduled-tasks</code>,{' '}
                <code className="text-[11px] font-mono">/channels</code>,{' '}
                <code className="text-[11px] font-mono">/tunnel</code>,{' '}
                <code className="text-[11px] font-mono">/connectors</code>. New
                management-style pages should compose the same pieces in the
                same order so the whole app feels like one product.
              </p>

              {/* ── PageHeader ── */}
              <div id="pat-page-header" className="mb-12">
                <ComponentLabel>PageHeader</ComponentLabel>
                <ComponentDesc>
                  The canonical hero for list/management pages. Rounded card
                  with animated background, centered icon tile, and a single
                  bold title line. Always rendered inside a container wrapper
                  with <code className="text-[11px] font-mono">max-w-7xl</code> horizontal padding.
                </ComponentDesc>
                <DemoContainer className="p-0 overflow-hidden">
                  <div className="p-6">
                    <PageHeader icon={Zap}>
                      <div className="space-y-2 sm:space-y-4">
                        <div className="text-2xl sm:text-3xl md:text-4xl font-semibold tracking-tight">
                          <span className="text-primary">Scheduled Tasks</span>
                        </div>
                      </div>
                    </PageHeader>
                  </div>
                </DemoContainer>
                <pre className="mt-3 text-[11px] font-mono text-muted-foreground bg-muted/20 rounded-lg px-4 py-3 overflow-x-auto">{`<div className="container mx-auto max-w-7xl px-3 sm:px-4 py-3 sm:py-4">
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
                  Item card used across every list page. Mouse-following
                  radial spotlight on hover plus a subtle border glow. Wrap
                  with <code className="text-[11px] font-mono">bg-card border border-border/50</code> and
                  apply your own inner padding.
                </ComponentDesc>
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
                <ComponentDesc>
                  Standard search pill placed in the action bar below the
                  PageHeader. Leave a <code className="text-[11px] font-mono">max-w-md</code> width so
                  it sits next to a right-aligned primary action without
                  taking over.
                </ComponentDesc>
                <DemoContainer>
                  <div className="flex items-center justify-between gap-4">
                    <PageSearchBar
                      value=""
                      onChange={() => {}}
                      placeholder="Search connections..."
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
                <ComponentLabel>Stagger Mount</ComponentLabel>
                <ComponentDesc>
                  Every management page mounts its three zones with a
                  staggered fade + slide. Header on entry, search bar
                  at <code className="text-[11px] font-mono">delay-75</code>, content at <code className="text-[11px] font-mono">delay-150</code>.
                </ComponentDesc>
                <DemoContainer>
                  <pre className="text-[11px] font-mono text-muted-foreground bg-muted/20 rounded-lg px-4 py-3 overflow-x-auto leading-relaxed">{`// Page header
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
              <p className="text-base text-muted-foreground leading-relaxed mb-8">
                Small composition pieces used inside project pages, issue
                details, and other structured internal surfaces that don't
                fit the hero + list shape.
              </p>

              {/* ── PageShell ── */}
              <div id="pat-page-shell" className="mb-12">
                <ComponentLabel>PageShell</ComponentLabel>
                <ComponentDesc>
                  The one layout wrapper. Standardises max-width, horizontal
                  padding, and scroll behavior. Four width presets:{' '}
                  <code className="text-[11px] font-mono">reading (720)</code>,{' '}
                  <code className="text-[11px] font-mono">default (1000)</code>,{' '}
                  <code className="text-[11px] font-mono">wide (1280)</code>,{' '}
                  <code className="text-[11px] font-mono">full</code>.
                </ComponentDesc>
                <DemoContainer>
                  <div className="rounded-lg border border-dashed border-border/60 py-10 text-center text-[11px] text-muted-foreground">
                    <code>&lt;PageShell width=&quot;default&quot;&gt; … &lt;/PageShell&gt;</code>
                    <div className="mt-1 opacity-60">max-w-[1000px] · px-6 lg:px-10 · py-10</div>
                  </div>
                </DemoContainer>
              </div>

              {/* ── Section ── */}
              <div id="pat-section" className="mb-12">
                <ComponentLabel>Section</ComponentLabel>
                <ComponentDesc>
                  Labelled section inside a PageShell. Uppercase micro-label,
                  optional trailing action, opinionated top margin between
                  siblings. No box, no chrome — typography and whitespace do
                  the work.
                </ComponentDesc>
                <DemoContainer>
                  <BrandSection label="About">
                    <p className="text-[14px] text-foreground leading-relaxed">
                      Description content lives here. Sections separate
                      concerns on a page without ever drawing a card.
                    </p>
                  </BrandSection>
                  <BrandSection
                    label="Details"
                    action={
                      <Button variant="ghost" size="sm" className="h-6 px-2 text-[11px]">
                        Edit
                      </Button>
                    }
                  >
                    <p className="text-[13px] text-muted-foreground">
                      A second section with a trailing action.
                    </p>
                  </BrandSection>
                </DemoContainer>
              </div>

              {/* ── DefinitionList ── */}
              <div id="pat-definition-list" className="mb-12">
                <ComponentLabel>DefinitionList</ComponentLabel>
                <ComponentDesc>
                  Key/value pairs. Fixed-width label column so values align
                  vertically. Optional dividers for a Linear-style meta list.
                </ComponentDesc>
                <DemoContainer>
                  <DefinitionList dividers>
                    <DefinitionRow label="Path">
                      <code className="text-[12px] font-mono text-foreground">
                        /workspace/jjk-domain-search
                      </code>
                    </DefinitionRow>
                    <DefinitionRow label="Created">2 days ago</DefinitionRow>
                    <DefinitionRow label="Updated">
                      <span className="tabular-nums">3m ago</span>
                    </DefinitionRow>
                    <DefinitionRow label="Sessions">8</DefinitionRow>
                  </DefinitionList>
                </DemoContainer>
              </div>

              {/* ── InlineMeta ── */}
              <div id="pat-inline-meta" className="mb-12">
                <ComponentLabel>InlineMeta</ComponentLabel>
                <ComponentDesc>
                  Dot-separated facts. Drop any number of children — falsy
                  ones are skipped. Used in page headers, row subtitles, card
                  footers.
                </ComponentDesc>
                <DemoContainer>
                  <InlineMeta>
                    <span className="font-mono text-foreground">
                      /workspace/jjk
                    </span>
                    <span>24 issues</span>
                    <span>created 2d ago</span>
                    <span>8 sessions</span>
                  </InlineMeta>
                </DemoContainer>
              </div>

              {/* ── EmptyState ── */}
              <div id="pat-empty-state" className="mb-12">
                <ComponentLabel>EmptyState</ComponentLabel>
                <ComponentDesc>
                  The calm teaching moment. Icon, headline, one-line
                  description, up to two actions. Used for zero-state views
                  across every list and detail page.
                </ComponentDesc>
                <DemoContainer className="p-0">
                  <EmptyState
                    icon={IconInbox}
                    title="No issues yet"
                    description="Create your first issue with C, or import from a session."
                    action={
                      <Button size="sm" className="h-8 px-4 text-[13px]">
                        New issue
                      </Button>
                    }
                    secondaryAction={
                      <Button variant="ghost" size="sm" className="h-8 px-3 text-[13px]">
                        Learn more
                      </Button>
                    }
                  />
                </DemoContainer>
              </div>
            </section>

            {/* ═══════════════ Anti-Patterns ═══════════════ */}
            <section id="anti-patterns">
              <SectionDivider />
                <h2 className="text-xs uppercase tracking-widest text-muted-foreground mb-5">
                  Anti-Patterns
                </h2>
                <p className="text-base text-muted-foreground leading-relaxed mb-8">
                  Code patterns that violate the design system. Follow these
                  rules to maintain consistency, accessibility, and performance
                  across the codebase.
                </p>

                <div className="space-y-6">
                  <AntiPatternBlock
                    title="AP-1: No inline style={} for fixed values"
                    description="Bypasses the utility system, can't be purged, creates specificity issues, invisible to design system audits."
                    bad={`<div style={{ height: '14px', overflow: 'hidden' }}>\n  Content\n</div>`}
                    good={`<div className="h-3.5 overflow-hidden">\n  Content\n</div>`}
                  />

                  <AntiPatternBlock
                    title="AP-2: No arbitrary text sizes"
                    description="Creates 1,188+ inconsistent type sizes. No semantic meaning. No relationship to the type scale."
                    bad={`<span className="text-[10px]">Label</span>\n<span className="text-[11px]">Meta</span>\n<span className="text-[13px]">Body</span>`}
                    good={`<span className="text-[10px]">Label</span>\n<span className="text-xs">Meta</span>\n<span className="text-sm">Body</span>`}
                  />

                  <AntiPatternBlock
                    title="AP-3: No raw <button> elements"
                    description="Raw buttons bypass variant system, have inconsistent sizing/padding/radius, no focus ring guarantee, no loading state support."
                    bad={`<button\n  className="px-3 py-1.5 rounded-lg\n    bg-neutral-100 hover:bg-neutral-200"\n  onClick={handleClick}\n>\n  Save\n</button>`}
                    good={`<Button\n  variant="secondary"\n  size="sm"\n  onClick={handleClick}\n>\n  Save\n</Button>`}
                  />

                  <AntiPatternBlock
                    title="AP-4: No transition-colors"
                    description="Animates every CSS property including width, height, padding. Causes layout thrashing. Performance killer on large lists."
                    bad={`<div className="transition-colors duration-200\n  hover:bg-accent">`}
                    good={`<div className="transition-colors\n  duration-moderate hover:bg-accent">`}
                  />

                  <AntiPatternBlock
                    title="AP-5: No hardcoded hex colors"
                    description="Completely bypasses the theme system. Will look wrong in non-default themes. Breaks dark mode."
                    bad={`<div className="text-emerald-500">\n  Success\n</div>\n<div style={{ color: '#3b82f6' }}>\n  Info\n</div>`}
                    good={`<div className="text-success">\n  Success\n</div>\n<div className="text-info">\n  Info\n</div>`}
                  />

                  <AntiPatternBlock
                    title="AP-6: No clickable <div> elements"
                    description="Not keyboard accessible. No focus ring. Not announced as interactive by screen readers."
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
                      'Use text-[Npx] arbitrary sizes',
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
