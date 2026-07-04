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
      default: 'h-9',
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

const tabsListHeightClasses: Record<TabsSize, string> = {
  default: 'h-9',
  xs: 'h-6',
  sm: 'h-8',
  md: 'h-10',
  lg: 'h-10',
};

type TabsListType = 'default' | 'underline' | 'secondary';

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
  animate?: 'fluid' | 'none';
}

function TabsList({
  className,
  type = 'default',
  size = 'default',
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
        type === 'secondary' &&
          'relative z-10 inline-flex h-full w-fit items-center justify-center gap-0.5 bg-transparent p-0.5',
        type === 'underline' &&
          'border-border **:data-[slot=tabs-trigger]:data-[state=active]:border-b-foreground **:data-[slot=tabs-trigger]:data-[state=inactive]:text-muted-foreground text-muted-foreground **:data-[slot=tabs-trigger]:data-[state=active]:text-foreground inline-flex w-fit items-center justify-center gap-0 rounded-none border-b **:data-[slot=tabs-trigger]:h-full **:data-[slot=tabs-trigger]:rounded-none **:data-[slot=tabs-trigger]:border-x-0 **:data-[slot=tabs-trigger]:border-t-0 **:data-[slot=tabs-trigger]:border-b-[1.5px] **:data-[slot=tabs-trigger]:border-b-transparent **:data-[slot=tabs-trigger]:bg-transparent **:data-[slot=tabs-trigger]:shadow-none **:data-[slot=tabs-trigger]:data-[state=active]:bg-transparent **:data-[slot=tabs-trigger]:data-[state=active]:shadow-none **:data-[slot=tabs-trigger]:data-[state=inactive]:bg-transparent',
        type === 'underline' && tabsListHeightClasses[size],
        type === 'underline' && className,
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
              indicatorClassName="bg-foreground rounded-[calc(var(--radius)-2.5px)]"
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
  variant = 'default',
  size: sizeProp,
  value,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Trigger> & {
  variant?: 'default' | 'large' | 'transparent' | 'underline' | 'secondary' | 'a_accent-i_outline';
  size?: TabsTriggerSize;
}) {
  const listType = React.useContext(TabsListTypeContext);
  const animate = React.useContext(TabsAnimateContext);
  const listSize = React.useContext(TabsSizeContext);
  const size = resolveTabsTriggerSize(sizeProp, listSize);
  const useSlidingIndicator =
    listType === 'default' && variant === 'default' && animate === 'fluid';
  const isUnderlineList = listType === 'underline' && variant === 'default';
  const isSecondaryList = listType === 'secondary' && variant === 'default';
  const isSecondaryVariant = variant === 'secondary';

  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      data-sliding-tab={useSlidingIndicator ? value : undefined}
      value={value}
      className={cn(
        "focus-visible:ring-kortix-blue duration-normal ease-default inline-flex flex-1 items-center justify-center rounded-[calc(var(--radius)-2.5px)] border border-transparent whitespace-nowrap transition-[color,background-color,border-color,box-shadow] focus-visible:ring-[0.6px] focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50 motion-reduce:transition-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        tabsTriggerTextVariants({ size }),
        variant === 'default' &&
          cn(
            tabsTriggerPaddingVariants({ size }),
            isUnderlineList
              ? 'h-full'
              : isSecondaryList
                ? 'h-[calc(100%-4px)]'
                : tabsTriggerHeightVariants({ size }),
          ),
        useSlidingIndicator &&
          'data-[state=active]:text-background data-[state=inactive]:text-foreground/60 hover:data-[state=inactive]:text-foreground/80 relative z-10 data-[state=active]:bg-transparent data-[state=inactive]:bg-transparent',
        isUnderlineList &&
          'data-[state=active]:text-foreground data-[state=inactive]:text-muted-foreground hover:data-[state=inactive]:text-foreground rounded-none bg-transparent shadow-none data-[state=active]:bg-transparent data-[state=active]:shadow-none data-[state=inactive]:bg-transparent',
        isSecondaryList &&
          cn(
            'border-transparent bg-transparent shadow-none transition-colors duration-150',
            'data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:ring-foreground/6 data-[state=active]:shadow-sm data-[state=active]:ring-1',
            'data-[state=inactive]:text-muted-foreground/60 hover:data-[state=inactive]:text-foreground/80 data-[state=inactive]:bg-transparent',
          ),
        variant === 'default' &&
          !useSlidingIndicator &&
          !isUnderlineList &&
          !isSecondaryList &&
          'data-[state=active]:bg-foreground data-[state=active]:text-background data-[state=inactive]:text-foreground/60 hover:data-[state=inactive]:text-foreground/80 data-[state=inactive]:bg-transparent',

        className,
        variant === 'large' &&
          'border-border/80 h-10 border px-4 data-[state=inactive]:bg-transparent',
        variant === 'transparent' &&
          'text-primary data-[state=active]:text-primary data-[state=inactive]:text-primary bg-transparent data-[state=active]:border-transparent data-[state=active]:bg-transparent data-[state=active]:shadow-none data-[state=inactive]:bg-transparent dark:data-[state=active]:border-none',
        variant === 'underline' &&
          'text-primary data-[state=active]:border-primary data-[state=active]:text-primary data-[state=inactive]:text-primary rounded-none border-b-2 border-transparent bg-transparent data-[state=active]:border-b-2 data-[state=active]:bg-transparent data-[state=active]:shadow-none data-[state=inactive]:bg-transparent',
        isSecondaryVariant &&
          cn(
            tabsTriggerPaddingVariants({ size }),
            tabsTriggerHeightVariants({ size }),
            'flex-none border-transparent bg-transparent shadow-none',
            'data-[state=active]:bg-foreground data-[state=active]:text-background',
            'data-[state=inactive]:text-muted-foreground hover:data-[state=inactive]:text-foreground data-[state=inactive]:bg-transparent',
          ),
        variant === 'a_accent-i_outline' &&
          'data-[state=inactive]:border-border data-[state=active]:bg-foreground/5 data-[state=active]:text-accent-foreground data-[state=inactive]:text-foreground data-[state=active]:hover:bg-foreground/10 data-[state=inactive]:hover:bg-foreground/5 data-[state=inactive]:hover:text-foreground dark:data-[state=active]:bg-foreground/5 dark:data-[state=active]:text-accent-foreground dark:data-[state=inactive]:text-foreground px-2 data-[state=active]:border-transparent data-[state=active]:shadow-none data-[state=inactive]:bg-transparent dark:data-[state=active]:border-transparent',
          className
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
  animate?: 'fluid' | 'none';
}

function TabsListCompact({
  className,
  type = 'default',
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
        type === 'secondary' &&
          'bg-foreground/5 relative z-10 inline-flex h-full w-fit items-center justify-center gap-0.5 p-0.5',
        type === 'underline' &&
          'border-border **:data-[slot=tabs-trigger]:data-[state=active]:border-b-foreground **:data-[slot=tabs-trigger]:data-[state=inactive]:text-muted-foreground text-muted-foreground **:data-[slot=tabs-trigger]:data-[state=active]:text-foreground inline-flex h-7 w-fit items-center justify-center gap-0 rounded-none border-b **:data-[slot=tabs-trigger]:h-full **:data-[slot=tabs-trigger]:rounded-none **:data-[slot=tabs-trigger]:border-x-0 **:data-[slot=tabs-trigger]:border-t-0 **:data-[slot=tabs-trigger]:border-b-[1.5px] **:data-[slot=tabs-trigger]:border-b-transparent **:data-[slot=tabs-trigger]:bg-transparent **:data-[slot=tabs-trigger]:shadow-none **:data-[slot=tabs-trigger]:data-[state=active]:bg-transparent **:data-[slot=tabs-trigger]:data-[state=active]:shadow-none **:data-[slot=tabs-trigger]:data-[state=inactive]:bg-transparent',
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
              indicatorClassName="bg-foreground rounded-[calc(var(--radius)-3px)]"
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
  value,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  const listType = React.useContext(TabsListTypeContext);
  const animate = React.useContext(TabsAnimateContext);
  const useSlidingIndicator = listType === 'default' && animate === 'fluid';
  const isUnderlineList = listType === 'underline';
  const isSecondaryList = listType === 'secondary';

  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      data-sliding-tab={useSlidingIndicator ? value : undefined}
      value={value}
      className={cn(
        'focus-visible:ring-kortix-blue relative z-10 inline-flex flex-1 cursor-pointer items-center justify-center border border-transparent text-xs font-medium whitespace-nowrap focus-visible:ring-[0.6px] focus-visible:outline-none',
        tabsTriggerPaddingVariants({ size: 'xs' }),
        isUnderlineList
          ? 'h-full rounded-none'
          : isSecondaryList
            ? 'h-[calc(100%-4px)]'
            : tabsTriggerHeightVariants({ size: 'xs' }),
        useSlidingIndicator &&
          'data-[state=active]:text-background data-[state=inactive]:text-foreground/60 hover:data-[state=inactive]:text-foreground/80 rounded-[calc(var(--radius)-3px)] transition-colors duration-150 data-[state=active]:bg-transparent data-[state=inactive]:bg-transparent',
        isUnderlineList &&
          'duration-normal ease-default data-[state=active]:text-foreground data-[state=inactive]:text-muted-foreground hover:data-[state=inactive]:text-foreground rounded-none bg-transparent shadow-none transition-[color,background-color,border-color,box-shadow] data-[state=active]:bg-transparent data-[state=active]:shadow-none data-[state=inactive]:bg-transparent motion-reduce:transition-none',
        isSecondaryList &&
          'data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:ring-foreground/6 data-[state=inactive]:text-muted-foreground/60 hover:data-[state=inactive]:text-foreground/80 border-transparent bg-transparent shadow-none transition-colors duration-150 data-[state=active]:shadow-sm data-[state=active]:ring-1 data-[state=inactive]:bg-transparent',
        !useSlidingIndicator &&
          !isUnderlineList &&
          !isSecondaryList &&
          'data-[state=active]:bg-foreground data-[state=active]:text-background data-[state=inactive]:text-foreground/60 hover:data-[state=inactive]:text-foreground/80 rounded-[calc(var(--radius)-3px)] data-[state=inactive]:bg-transparent',
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

export type { TabsListType, TabsSize, TabsTriggerSize };
