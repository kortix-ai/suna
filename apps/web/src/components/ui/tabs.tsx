'use client';

import * as TabsPrimitive from '@radix-ui/react-tabs';
import { cva } from 'class-variance-authority';
import * as React from 'react';

import { SlidingTabIndicator } from '@/components/ui/sliding-tab-indicator';
import { cn } from '@/lib/utils';

const tabsTriggerPaddingVariants = cva('', {
  variants: {
    size: {
      default: 'gap-2 px-4 py-2 has-[>svg]:px-3',
      xs: 'gap-1.5 px-2.5 has-[>svg]:px-2',
      sm: 'gap-1.5 px-3 has-[>svg]:px-2.5',
      md: 'gap-2 px-5 has-[>svg]:px-4',
      lg: 'gap-2 px-6 has-[>svg]:px-4',
    },
  },
  defaultVariants: {
    size: 'default',
  },
});

const tabsTriggerHeightVariants = cva('', {
  variants: {
    size: {
      default: 'h-8',
      xs: 'h-7',
      sm: 'h-8',
      md: 'h-10',
      lg: 'h-10',
    },
  },
  defaultVariants: {
    size: 'default',
  },
});

/** Shared tab typography for web and desktop. */
const tabsTriggerTextVariants = cva('font-medium', {
  variants: {
    size: {
      default: 'text-sm',
      xs: 'text-xs rounded-sm',
      sm: 'text-xs',
      md: 'text-sm',
      lg: 'text-sm',
    },
  },
  defaultVariants: {
    size: 'default',
  },
});

type TabsTriggerSize = 'xs' | 'sm' | 'default' | 'md';
type TabsSize = TabsTriggerSize | 'lg';
/**
 * `default` is the filled pill; `outline` is a bordered active chip;
 * `segmented` is the raised surface chip of a segmented control.
 */
type TabsTriggerVariant = 'default' | 'outline' | 'segmented';

const tabsListHeightClasses: Record<TabsSize, string> = {
  default: 'h-9',
  xs: 'h-6',
  sm: 'h-8',
  md: 'h-10',
  lg: 'h-10',
};

/** Stroke thickness of the active underline rule (`type="underline"` only). */
type TabsUnderlineSize = 'xs' | 'sm' | 'md' | 'lg';

const tabsUnderlineBorderClasses: Record<TabsUnderlineSize, string> = {
  xs: '**:data-[slot=tabs-trigger]:after:h-px',
  sm: '**:data-[slot=tabs-trigger]:after:h-[1.5px]',
  md: '**:data-[slot=tabs-trigger]:after:h-0.5',
  lg: '**:data-[slot=tabs-trigger]:after:h-[3px]',
};

/** Shared underline-list chrome; indicator height comes from `underlineSize`. */
const tabsListUnderlineBaseClasses =
  "border-border **:data-[slot=tabs-trigger]:data-[state=inactive]:text-muted-foreground text-muted-foreground **:data-[slot=tabs-trigger]:data-[state=active]:text-foreground inline-flex w-fit items-center justify-center gap-0 rounded-none border-b **:data-[slot=tabs-trigger]:relative **:data-[slot=tabs-trigger]:h-full **:data-[slot=tabs-trigger]:rounded-none **:data-[slot=tabs-trigger]:border-0 **:data-[slot=tabs-trigger]:bg-transparent **:data-[slot=tabs-trigger]:shadow-none **:data-[slot=tabs-trigger]:after:pointer-events-none **:data-[slot=tabs-trigger]:after:absolute **:data-[slot=tabs-trigger]:after:inset-x-0 **:data-[slot=tabs-trigger]:after:bottom-0 **:data-[slot=tabs-trigger]:after:rounded-full **:data-[slot=tabs-trigger]:after:bg-transparent **:data-[slot=tabs-trigger]:after:content-[''] **:data-[slot=tabs-trigger]:data-[state=active]:bg-transparent **:data-[slot=tabs-trigger]:data-[state=active]:shadow-none **:data-[slot=tabs-trigger]:data-[state=active]:after:bg-foreground **:data-[slot=tabs-trigger]:data-[state=inactive]:bg-transparent";

/**
 * `default` is the segmented control: a recessed track whose active tab is a
 * raised surface chip. `segmented` is the same control, kept as an explicit
 * name. `underline` is the flat rule. A vertical list (a settings rail) is
 * never segmented.
 */
type TabsListType = 'default' | 'underline' | 'segmented';

/**
 * Segmented track + chip. Radii are concentric: the track is `rounded-md` (8px)
 * with 2px of padding, so the chip is `rounded-sm` (6px). The chip lifts with a
 * hairline ring plus `shadow-xs` — raised, not bordered, so it reads as the
 * selected thing in both themes.
 *
 * The padding is `p-[2px]`, not `p-0.5`: `--spacing` is 0.23rem, so `p-0.5` is
 * 1.84px. The chip's 1px ring leaves 0.84px of track showing, and a fraction of
 * a pixel rounds differently on each side — 1px of track on one end and none on
 * the other at 1x. A whole 2px leaves exactly 1px on every side.
 */
const tabsSegmentedTrackClasses = 'bg-muted rounded-md p-[2px]';
const tabsSegmentedChipClasses = 'bg-popover ring-border rounded-sm shadow-xs ring-1';

function resolveTabsTriggerSize(
  sizeProp: TabsTriggerSize | undefined,
  listSize: TabsSize,
): TabsSize {
  if (sizeProp) return sizeProp;
  if (listSize === 'xs') return 'xs';
  if (listSize === 'lg') return 'md';
  return listSize;
}

const TabsActiveValueContext = React.createContext<string>('');
const TabsListTypeContext = React.createContext<TabsListType>('default');
const TabsAnimateContext = React.createContext<'fluid' | 'none'>('fluid');
const TabsSizeContext = React.createContext<TabsSize>('default');
/** Lets `TabsTrigger` adapt to a vertical `TabsList` without every caller re-passing orientation. */
const TabsOrientationContext = React.createContext<'horizontal' | 'vertical'>('horizontal');

function Tabs({
  className,
  value,
  defaultValue,
  onValueChange,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Root>) {
  const [uncontrolledValue, setUncontrolledValue] = React.useState(defaultValue ?? '');
  const activeValue = value !== undefined ? value : uncontrolledValue;

  const handleValueChange = React.useCallback(
    (next: string) => {
      if (value === undefined) {
        setUncontrolledValue(next);
      }
      onValueChange?.(next);
    },
    [onValueChange, value],
  );

  return (
    <TabsActiveValueContext.Provider value={activeValue}>
      <TabsPrimitive.Root
        data-slot="tabs"
        className={cn('flex flex-col gap-2', className)}
        value={value}
        defaultValue={defaultValue}
        onValueChange={handleValueChange}
        {...props}
      />
    </TabsActiveValueContext.Provider>
  );
}

interface TabsListProps extends React.ComponentProps<typeof TabsPrimitive.List> {
  type?: TabsListType;
  /**
   * `segmented` renders the segmented control (recessed track + raised chip):
   * `<TabsList variant="segmented">`. Same as `type="segmented"`; `variant`
   * wins when both are set.
   */
  variant?: 'default' | 'segmented';
  size?: TabsSize;
  /** Active underline stroke. Only applies when `type="underline"`. Default `sm`. */
  underlineSize?: TabsUnderlineSize;
  animate?: 'fluid' | 'none';
  /**
   * `vertical` stacks triggers full-width in a column (e.g. a settings
   * rail) instead of laying them out inline. This is a styling switch only —
   * `aria-orientation` still comes from `orientation` on the `Tabs` root, per
   * Radix. Default `horizontal`.
   */
  orientation?: 'horizontal' | 'vertical';
}

function TabsList(props: TabsListProps) {
  return <TabsListRenderer {...props} orientation={props.orientation ?? 'horizontal'} />;
}

function TabsListRenderer({
  className, type: typeProp = 'default', variant, size = 'default',
  underlineSize = 'sm', animate = 'fluid', orientation, compact = false,
  children, ...props
}: TabsListProps & { compact?: boolean }) {
  const activeValue = React.useContext(TabsActiveValueContext);
  const isVertical = !compact && orientation === 'vertical';
  const requested: TabsListType = variant === 'segmented' ? 'segmented' : typeProp;
  // Every horizontal list that is not `underline` is the segmented control.
  // Triggers read the resolved type from context, so a vertical rail keeps its
  // own row styling.
  const type: TabsListType =
    requested === 'underline' ? 'underline' : isVertical ? 'default' : 'segmented';
  const isSegmented = type === 'segmented';
  const useSlidingIndicator = isSegmented && animate === 'fluid';
  const trackClassName = cn(
    compact
      ? 'text-muted-foreground inline-flex h-7 w-fit items-center justify-center'
      : 'text-muted-foreground inline-flex w-fit items-center justify-center',
    !compact && tabsListHeightClasses[size], tabsSegmentedTrackClasses, className,
  );
  const list = (
    <TabsPrimitive.List
      data-slot="tabs-list"
      className={cn(
        isSegmented && 'relative z-10 flex h-full w-full items-stretch justify-center gap-0.5',
        !isVertical && type === 'underline' && tabsListUnderlineBaseClasses,
        compact && type === 'underline' && 'h-7',
        !isVertical && type === 'underline' && tabsUnderlineBorderClasses[underlineSize],
        !compact && !isVertical && type === 'underline' && tabsListHeightClasses[size],
        isVertical && 'flex h-auto w-full flex-col items-stretch gap-0.5 rounded-none bg-transparent p-0',
        (!compact || type === 'underline') && className,
      )}
      {...props}
    >
      {children}
    </TabsPrimitive.List>
  );
  // The sliding pill indicator only measures the x-axis (see
  // SlidingTabIndicator) — in a column it would collapse to a
  // zero-width bar, so vertical lists render without it.
  const content = isVertical || type === 'underline' ? list : useSlidingIndicator ? (
    <SlidingTabIndicator activeId={activeValue} className={trackClassName}
      indicatorClassName={tabsSegmentedChipClasses}>{list}</SlidingTabIndicator>
  ) : <div className={trackClassName}>{list}</div>;
  return (
    <TabsListTypeContext.Provider value={type}>
      <TabsAnimateContext.Provider value={animate}>
        <TabsSizeContext.Provider value={size}>
          {compact ? content : (
            <TabsOrientationContext.Provider value={orientation ?? 'horizontal'}>
              {content}
            </TabsOrientationContext.Provider>
          )}
        </TabsSizeContext.Provider>
      </TabsAnimateContext.Provider>
    </TabsListTypeContext.Provider>
  );
}

function TabsTrigger({
  className,
  size: sizeProp,
  variant = 'default',
  value,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Trigger> & {
  size?: TabsTriggerSize;
  variant?: TabsTriggerVariant;
}) {
  const listType = React.useContext(TabsListTypeContext);
  const animate = React.useContext(TabsAnimateContext);
  const listSize = React.useContext(TabsSizeContext);
  const listOrientation = React.useContext(TabsOrientationContext);
  const size = resolveTabsTriggerSize(sizeProp, listSize);
  const isUnderlineList = listType === 'underline';
  // A segmented trigger either sits in a segmented list (the list's sliding
  // chip paints the active state) or asks for it alone with
  // `variant="segmented"` (it paints its own chip — there is no track to slide in).
  const isSegmentedList = listType === 'segmented';
  // An explicit `variant="outline"` keeps its bordered chip even in a segmented list.
  const isOutline = !isUnderlineList && variant === 'outline';
  const isSegmented = !isUnderlineList && !isOutline && (isSegmentedList || variant === 'segmented');
  // Outline paints its own border; the sliding pill fill would fight it.
  const useSlidingIndicator =
    !isUnderlineList &&
    !isOutline &&
    (!isSegmented || isSegmentedList) &&
    animate === 'fluid';
  const isVertical = listOrientation === 'vertical';

  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      data-sliding-tab={useSlidingIndicator ? value : undefined}
      data-variant={variant}
      value={value}
      className={cn(
        "focus-visible:ring-kortix-blue duration-normal ease-default inline-flex flex-1 cursor-pointer items-center justify-center rounded-[calc(var(--radius)-2.5px)] border border-transparent whitespace-nowrap transition-[color,background-color,border-color,box-shadow] focus-visible:ring-[0.6px] focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50 motion-reduce:transition-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        tabsTriggerTextVariants({ size }),
        tabsTriggerPaddingVariants({ size }),
        isUnderlineList || isSegmentedList ? 'h-full' : tabsTriggerHeightVariants({ size }),
        // Segmented: the chip sits inside the track's padding, so the trigger
        // fills the track and takes the chip's concentric radius.
        isSegmented && 'rounded-sm',
        // Without the sliding indicator the active trigger paints the chip itself.
        isSegmented &&
          !useSlidingIndicator &&
          'data-[state=active]:bg-popover data-[state=active]:ring-border data-[state=active]:shadow-xs data-[state=active]:ring-1',
        isUnderlineList &&
          'data-[state=active]:text-foreground data-[state=inactive]:text-muted-foreground hover:data-[state=inactive]:text-foreground rounded-none bg-transparent shadow-none data-[state=active]:bg-transparent data-[state=active]:shadow-none data-[state=inactive]:bg-transparent',
        // Default: a secondary-coloured pill. With animate="fluid" the sliding
        // indicator paints the pill behind the trigger, so the trigger itself
        // stays transparent; otherwise the trigger paints its own.
        !isUnderlineList &&
          !isOutline &&
          'data-[state=active]:text-foreground data-[state=inactive]:text-muted-foreground hover:data-[state=inactive]:text-foreground relative z-10 data-[state=inactive]:bg-transparent',
        !isUnderlineList &&
          !isOutline &&
          !isSegmented &&
          (useSlidingIndicator
            ? 'data-[state=active]:bg-transparent'
            : 'data-[state=active]:bg-input'),
        isSegmented && useSlidingIndicator && 'data-[state=active]:bg-transparent',
        // Outline: bordered active chip — matches Button `outline` (border + transparent fill).
        isOutline &&
          'data-[state=active]:text-foreground data-[state=inactive]:text-muted-foreground hover:data-[state=inactive]:bg-foreground/5 hover:data-[state=inactive]:text-foreground data-[state=active]:border-border relative z-10 bg-transparent data-[state=active]:bg-transparent data-[state=inactive]:bg-transparent',
        isVertical && 'w-full justify-start text-left',
        className,
      )}
      {...props}
    />
  );
}

function TabsContent({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      className={cn('flex-1 outline-none', className)}
      {...props}
    />
  );
}

/** Compact Radix TabsList — use inside <Tabs> root for smaller contexts. */
interface TabsListCompactProps extends React.ComponentProps<typeof TabsPrimitive.List> {
  type?: Exclude<TabsListType, 'segmented'>;
  /** Active underline stroke. Only applies when `type="underline"`. Default `sm`. */
  underlineSize?: TabsUnderlineSize;
  animate?: 'fluid' | 'none';
}

function TabsListCompact(props: TabsListCompactProps) {
  // Same rule as `TabsList`: anything that is not `underline` is segmented.
  return <TabsListRenderer {...props} size="xs" compact />;
}

/** Compact Radix TabsTrigger — use inside <Tabs> root for smaller contexts. */
function TabsTriggerCompact({
  className,
  variant = 'default',
  value,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Trigger> & {
  variant?: Exclude<TabsTriggerVariant, 'segmented'>;
}) {
  const listType = React.useContext(TabsListTypeContext);
  const animate = React.useContext(TabsAnimateContext);
  const isUnderlineList = listType === 'underline';
  const isOutline = !isUnderlineList && variant === 'outline';
  const isSegmented = !isUnderlineList && !isOutline;
  const useSlidingIndicator = isSegmented && animate === 'fluid';

  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      data-sliding-tab={useSlidingIndicator ? value : undefined}
      data-variant={variant}
      value={value}
      className={cn(
        'focus-visible:ring-kortix-blue relative z-10 inline-flex flex-1 cursor-pointer items-center justify-center border border-transparent text-xs font-medium whitespace-nowrap focus-visible:ring-[0.6px] focus-visible:outline-none',
        tabsTriggerPaddingVariants({ size: 'xs' }),
        isUnderlineList || isSegmented
          ? 'h-full'
          : tabsTriggerHeightVariants({ size: 'xs' }),
        isUnderlineList && 'rounded-none',
        isUnderlineList &&
          'duration-normal ease-default data-[state=active]:text-foreground data-[state=inactive]:text-muted-foreground hover:data-[state=inactive]:text-foreground rounded-none bg-transparent shadow-none transition-[color,background-color,border-color,box-shadow] data-[state=active]:bg-transparent data-[state=active]:shadow-none data-[state=inactive]:bg-transparent motion-reduce:transition-none',
        // Segmented (the default) — see TabsTrigger: the sliding chip paints the
        // active state, or the trigger paints it when there is no slide.
        isSegmented &&
          'data-[state=active]:text-foreground data-[state=inactive]:text-muted-foreground hover:data-[state=inactive]:text-foreground rounded-sm bg-transparent transition-colors duration-150',
        isSegmented &&
          !useSlidingIndicator &&
          'data-[state=active]:bg-popover data-[state=active]:ring-border data-[state=active]:shadow-xs data-[state=active]:ring-1',
        isOutline &&
          'data-[state=active]:text-foreground data-[state=inactive]:text-muted-foreground hover:data-[state=inactive]:bg-foreground/5 hover:data-[state=inactive]:text-foreground data-[state=active]:border-border rounded-[calc(var(--radius)-3px)] bg-transparent transition-[color,background-color,border-color] duration-150 data-[state=active]:bg-transparent data-[state=inactive]:bg-transparent',
        'disabled:pointer-events-none disabled:opacity-50',
        "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
        className,
      )}
      {...props}
    />
  );
}

/** Standalone filter pill bar — works WITHOUT a <Tabs> root. Use for filter bars, mode toggles. */
function FilterBar({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="filter-bar"
      role="tablist"
      className={cn(
        'bg-foreground/5 text-muted-foreground inline-flex h-9 w-fit items-center justify-center gap-0.5 p-0.5',
        className,
      )}
      {...props}
    />
  );
}

/** Standalone filter pill — works WITHOUT a <Tabs> root. Pair with FilterBar. */
function FilterBarItem({ className, ...props }: React.ComponentProps<'button'>) {
  return (
    <button
      data-slot="filter-bar-item"
      role="tab"
      type="button"
      className={cn(
        'inline-flex h-[calc(100%-4px)] flex-1 cursor-pointer items-center justify-center gap-1.5 border border-transparent px-3 py-1.5 text-sm font-medium whitespace-nowrap transition-colors duration-150',
        'text-muted-foreground/60 hover:text-foreground/80',
        'data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:ring-foreground/6 data-[state=active]:shadow-sm data-[state=active]:ring-1',
        'disabled:pointer-events-none disabled:opacity-50',
        "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
        className,
      )}
      {...props}
    />
  );
}

export {
  FilterBar,
  FilterBarItem,
  Tabs,
  TabsContent,
  TabsList,
  TabsListCompact,
  TabsTrigger,
  TabsTriggerCompact,
  tabsTriggerHeightVariants,
  tabsTriggerPaddingVariants,
  tabsTriggerTextVariants,
};

export type { TabsListType, TabsSize, TabsTriggerSize, TabsTriggerVariant, TabsUnderlineSize };
