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

/**
 * Web sizing only. The desktop shell overrides all of it with a flat
 * `html[data-desktop='true'] [role='tablist'] [role='tab'] { font-size }` rule
 * in globals.css — a descendant selector on <html> beats these utility
 * classes, so changing a size here has NO effect inside the desktop app.
 * Change tab text there, not here.
 */
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
/** `default` is the filled pill; `outline` is a bordered active chip. */
type TabsTriggerVariant = 'default' | 'outline';

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

/** `default` is the secondary-coloured pill bar; `underline` is the flat rule. */
type TabsListType = 'default' | 'underline';

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
  size?: TabsSize;
  /** Active underline stroke. Only applies when `type="underline"`. Default `sm`. */
  underlineSize?: TabsUnderlineSize;
  animate?: 'fluid' | 'none';
}

function TabsList({
  className,
  type = 'default',
  size = 'default',
  underlineSize = 'sm',
  animate = 'fluid',
  children,
  ...props
}: TabsListProps) {
  const activeValue = React.useContext(TabsActiveValueContext);
  const useSlidingIndicator = type === 'default' && animate === 'fluid';

  const list = (
    <TabsPrimitive.List
      data-slot="tabs-list"
      className={cn(
        type === 'default' &&
          'relative z-10 inline-flex h-full w-fit items-center justify-center gap-1',
        type === 'underline' && tabsListUnderlineBaseClasses,
        type === 'underline' && tabsUnderlineBorderClasses[underlineSize],
        type === 'underline' && tabsListHeightClasses[size],
        className,
      )}
      {...props}
    >
      {children}
    </TabsPrimitive.List>
  );

  return (
    <TabsListTypeContext.Provider value={type}>
      <TabsAnimateContext.Provider value={animate}>
        <TabsSizeContext.Provider value={size}>
          {useSlidingIndicator ? (
            <SlidingTabIndicator
              activeId={activeValue}
              className={cn(
                'text-muted-foreground inline-flex w-fit items-center justify-center',
                tabsListHeightClasses[size],
                className,
              )}
              indicatorClassName="bg-input rounded-[calc(var(--radius)-2.5px)]"
            >
              {list}
            </SlidingTabIndicator>
          ) : type === 'underline' ? (
            list
          ) : (
            <div
              className={cn(
                'text-muted-foreground inline-flex w-fit items-center justify-center',
                tabsListHeightClasses[size],
                className,
              )}
            >
              {list}
            </div>
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
  const size = resolveTabsTriggerSize(sizeProp, listSize);
  const isUnderlineList = listType === 'underline';
  const isOutline = !isUnderlineList && variant === 'outline';
  // Outline paints its own border; the sliding pill fill would fight it.
  const useSlidingIndicator = !isUnderlineList && !isOutline && animate === 'fluid';

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
        isUnderlineList ? 'h-full' : tabsTriggerHeightVariants({ size }),
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
          (useSlidingIndicator
            ? 'data-[state=active]:bg-transparent'
            : 'data-[state=active]:bg-input'),
        // Outline: bordered active chip — matches Button `outline` (border + transparent fill).
        isOutline &&
          'data-[state=active]:text-foreground data-[state=inactive]:text-muted-foreground hover:data-[state=inactive]:bg-foreground/5 hover:data-[state=inactive]:text-foreground relative z-10 bg-transparent data-[state=active]:border-border data-[state=active]:bg-transparent data-[state=inactive]:bg-transparent',
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
  type?: TabsListType;
  /** Active underline stroke. Only applies when `type="underline"`. Default `sm`. */
  underlineSize?: TabsUnderlineSize;
  animate?: 'fluid' | 'none';
}

function TabsListCompact({
  className,
  type = 'default',
  underlineSize = 'sm',
  animate = 'fluid',
  children,
  ...props
}: TabsListCompactProps) {
  const activeValue = React.useContext(TabsActiveValueContext);
  const useSlidingIndicator = type === 'default' && animate === 'fluid';

  const list = (
    <TabsPrimitive.List
      data-slot="tabs-list"
      className={cn(
        type === 'default' &&
          'relative z-10 inline-flex h-full w-fit items-center justify-center gap-0.5',
        type === 'underline' && tabsListUnderlineBaseClasses,
        type === 'underline' && 'h-7',
        type === 'underline' && tabsUnderlineBorderClasses[underlineSize],
        type === 'underline' && className,
      )}
      {...props}
    >
      {children}
    </TabsPrimitive.List>
  );

  return (
    <TabsListTypeContext.Provider value={type}>
      <TabsAnimateContext.Provider value={animate}>
        <TabsSizeContext.Provider value="xs">
          {useSlidingIndicator ? (
            <SlidingTabIndicator
              activeId={activeValue}
              className={cn(
                'text-muted-foreground inline-flex h-7 w-fit items-center justify-center gap-0.5',
                className,
              )}
              indicatorClassName="bg-input rounded-[calc(var(--radius)-3px)]"
            >
              {list}
            </SlidingTabIndicator>
          ) : type === 'underline' ? (
            list
          ) : (
            <div
              className={cn(
                'text-muted-foreground inline-flex h-7 w-fit items-center justify-center gap-0.5',
                className,
              )}
            >
              {list}
            </div>
          )}
        </TabsSizeContext.Provider>
      </TabsAnimateContext.Provider>
    </TabsListTypeContext.Provider>
  );
}

/** Compact Radix TabsTrigger — use inside <Tabs> root for smaller contexts. */
function TabsTriggerCompact({
  className,
  variant = 'default',
  value,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Trigger> & {
  variant?: TabsTriggerVariant;
}) {
  const listType = React.useContext(TabsListTypeContext);
  const animate = React.useContext(TabsAnimateContext);
  const isUnderlineList = listType === 'underline';
  const isOutline = !isUnderlineList && variant === 'outline';
  const useSlidingIndicator = !isUnderlineList && !isOutline && animate === 'fluid';

  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      data-sliding-tab={useSlidingIndicator ? value : undefined}
      data-variant={variant}
      value={value}
      className={cn(
        'focus-visible:ring-kortix-blue relative z-10 inline-flex flex-1 cursor-pointer items-center justify-center border border-transparent text-xs font-medium whitespace-nowrap focus-visible:ring-[0.6px] focus-visible:outline-none',
        tabsTriggerPaddingVariants({ size: 'xs' }),
        isUnderlineList ? 'h-full rounded-none' : tabsTriggerHeightVariants({ size: 'xs' }),
        isUnderlineList &&
          'duration-normal ease-default data-[state=active]:text-foreground data-[state=inactive]:text-muted-foreground hover:data-[state=inactive]:text-foreground rounded-none bg-transparent shadow-none transition-[color,background-color,border-color,box-shadow] data-[state=active]:bg-transparent data-[state=active]:shadow-none data-[state=inactive]:bg-transparent motion-reduce:transition-none',
        // Default: a secondary-coloured pill — see TabsTrigger for why the
        // active fill is conditional on the sliding indicator.
        !isUnderlineList &&
          !isOutline &&
          'data-[state=active]:text-foreground data-[state=inactive]:text-muted-foreground hover:data-[state=inactive]:text-foreground rounded-[calc(var(--radius)-3px)] transition-colors duration-150 data-[state=inactive]:bg-transparent',
        !isUnderlineList &&
          !isOutline &&
          (useSlidingIndicator
            ? 'data-[state=active]:bg-transparent'
            : 'data-[state=active]:bg-input'),
        isOutline &&
          'data-[state=active]:text-foreground data-[state=inactive]:text-muted-foreground hover:data-[state=inactive]:bg-foreground/5 hover:data-[state=inactive]:text-foreground rounded-[calc(var(--radius)-3px)] bg-transparent transition-[color,background-color,border-color] duration-150 data-[state=active]:border-border data-[state=active]:bg-transparent data-[state=inactive]:bg-transparent',
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
        'data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm',
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

export type {
  TabsListType,
  TabsSize,
  TabsTriggerSize,
  TabsTriggerVariant,
  TabsUnderlineSize,
};
