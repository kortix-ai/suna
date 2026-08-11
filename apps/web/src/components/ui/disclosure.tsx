'use client';

import { cn } from '@/lib/utils';
import { AnimatePresence, m, MotionConfig, Transition, Variant, Variants } from 'motion/react';
import * as React from 'react';
import { createContext, useCallback, useContext, useId, useMemo, useState } from 'react';

export type DisclosureContextType = {
  open: boolean;
  toggle: () => void;
  variants?: { expanded: Variant; collapsed: Variant };
};

const DisclosureContext = createContext<DisclosureContextType | undefined>(undefined);

/**
 * What activating the trigger should do. Extracted as a pure function so the
 * contract has something to test: `apps/web` has no browser test harness (only
 * `renderToStaticMarkup`), so a click cannot be simulated, and this is the exact
 * decision that was wrong before.
 *
 * `nextOpen` negates the value the disclosure is CURRENTLY RENDERING. The old
 * implementation negated a private copy of it instead, which is how a click
 * could resolve to the state the disclosure was already in and appear to do
 * nothing at all.
 */
export function resolveDisclosureToggle(state: { open: boolean; isControlled: boolean }): {
  nextOpen: boolean;
  /** Only an uncontrolled disclosure owns state. A controlled one holds none —
   *  keeping a copy is what produced the two-sources-of-truth bug. */
  writesInternalState: boolean;
} {
  return { nextOpen: !state.open, writesInternalState: !state.isControlled };
}

export type DisclosureProviderProps = {
  children: React.ReactNode;
  /** Controlled. Omit entirely (not `false`) for an uncontrolled disclosure. */
  open?: boolean;
  /** Uncontrolled starting value. Ignored when `open` is provided. */
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  variants?: { expanded: Variant; collapsed: Variant };
};

/**
 * Controlled OR uncontrolled, with exactly one source of truth for `open` —
 * the same contract every Radix primitive in this codebase uses.
 *
 * This replaces a mirrored-state design that copied `open` into internal state
 * and reconciled the two in a `useEffect`. That shape produced the reported
 * "click does nothing, then it opens by itself" flakiness through four separate
 * defects, all of which are structural rather than incidental:
 *
 *  1. `toggle` computed `!internalCopy`, not `!open`. Any moment the copy and
 *     the prop disagreed, a click moved the disclosure the wrong way — or
 *     landed on the value it already had, so nothing visibly happened.
 *  2. The prop → copy sync ran in a PASSIVE effect, i.e. after paint. A
 *     prop-driven open animated a frame late and looked spontaneous, and in an
 *     exclusive accordion (session-scope-control.tsx) both sections were open
 *     together for that frame.
 *  3. `onOpenChange` was called from inside the `setState` updater. React
 *     requires updaters to be pure and is free to invoke them more than once;
 *     a parent whose handler toggles (`onOpenChange={() => toggleThing()}` —
 *     what both session lists pass) then nets to zero and never moves.
 *  4. `open` defaulted to `false`, so "controlled and closed" and "uncontrolled"
 *     were indistinguishable and no caller could opt out of being controlled.
 *
 * Here `open` is read straight from whichever source owns it, so a controlled
 * parent's change lands in the same commit as its own render, and `toggle`
 * always derives from the value actually on screen.
 */
function DisclosureProvider({
  children,
  open: openProp,
  defaultOpen = false,
  onOpenChange,
  variants,
}: DisclosureProviderProps) {
  const isControlled = openProp !== undefined;
  const [uncontrolledOpen, setUncontrolledOpen] = useState<boolean>(defaultOpen);
  const open = isControlled ? openProp : uncontrolledOpen;

  const toggle = useCallback(() => {
    const { nextOpen, writesInternalState } = resolveDisclosureToggle({ open, isControlled });
    if (writesInternalState) setUncontrolledOpen(nextOpen);
    // In the event handler, once — never inside a state updater.
    onOpenChange?.(nextOpen);
  }, [open, isControlled, onOpenChange]);

  /**
   * A fresh object here re-rendered every `useDisclosure()` consumer on every
   * render of this provider, whether or not `open` had changed — and a session
   * transcript nests two to three disclosures per tool row (the chain step, the
   * tool's own collapsible, sometimes a group), so the churn multiplied by every
   * row on screen.
   */
  const value = useMemo(() => ({ open, toggle, variants }), [open, toggle, variants]);

  return <DisclosureContext.Provider value={value}>{children}</DisclosureContext.Provider>;
}

function useDisclosure() {
  const context = useContext(DisclosureContext);
  if (!context) {
    throw new Error('useDisclosure must be used within a DisclosureProvider');
  }
  return context;
}

export type DisclosureProps = {
  /**
   * Controlled value. Pass it WITH `onOpenChange`, or the disclosure is frozen
   * — there is no internal copy to fall back on any more, by design.
   * For "starts open, then the user decides", use `defaultOpen`.
   */
  open?: boolean;
  /** Uncontrolled starting value. Ignored when `open` is provided. */
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: React.ReactNode;
  className?: string;
  variants?: { expanded: Variant; collapsed: Variant };
  transition?: Transition;
  variant?: 'default' | 'outline';
};

function DisclosureRoot({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  const { open } = useDisclosure();
  return (
    <div className={className} data-state={open ? 'open' : 'closed'}>
      {children}
    </div>
  );
}

export function Disclosure({
  open: openProp,
  defaultOpen,
  onOpenChange,
  children,
  className,
  transition,
  variants,
  variant = 'default',
}: DisclosureProps) {
  return (
    <MotionConfig transition={transition}>
      <DisclosureProvider
        open={openProp}
        defaultOpen={defaultOpen}
        onOpenChange={onOpenChange}
        variants={variants}
      >
        <DisclosureRoot
          className={cn(
            variant === 'outline' && 'group border-border w-full rounded-md border shadow-none',
            className,
          )}
        >
          {React.Children.toArray(children)[0]}
          {React.Children.toArray(children)[1]}
        </DisclosureRoot>
      </DisclosureProvider>
    </MotionConfig>
  );
}

export function DisclosureTrigger({
  children,
  className,
  variant = 'default',
}: {
  children: React.ReactNode;
  className?: string;
  variant?: 'default' | 'outline';
}) {
  const { toggle, open } = useDisclosure();

  return (
    <>
      {React.Children.map(children, (child) => {
        if (!React.isValidElement(child)) return child;

        // Type the child element more specifically
        type ButtonLikeProps = {
          onClick?: React.MouseEventHandler;
          role?: string;
          'aria-expanded'?: boolean;
          tabIndex?: number;
          onKeyDown?: React.KeyboardEventHandler;
          className?: string;
        };

        const typedChild = child as React.ReactElement<ButtonLikeProps>;
        const childClassName = typedChild.props.className;

        return React.cloneElement(typedChild, {
          onClick: toggle,
          role: 'button',
          'aria-expanded': open,
          tabIndex: 0,
          onKeyDown: (e: React.KeyboardEvent) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              toggle();
            }
          },
          className: cn(
            className,
            childClassName,
            variant === 'outline' &&
              'group-data-[state=open]:rounded-b-none group-data-[state=open]:border-b-0',
          ),
        });
      })}
    </>
  );
}

export function DisclosureContent({
  children,
  className,
  contentClassName,
  variant = 'default',
}: {
  children: React.ReactNode;
  className?: string;
  contentClassName?: string;
  variant?: 'default' | 'outline';
}) {
  const { open, variants } = useDisclosure();
  const uniqueId = useId();

  const BASE_VARIANTS: Variants = {
    expanded: {
      height: 'auto',
      opacity: 1,
    },
    collapsed: {
      height: 0,
      opacity: 0,
    },
  };

  const combinedVariants = {
    expanded: { ...BASE_VARIANTS.expanded, ...variants?.expanded },
    collapsed: { ...BASE_VARIANTS.collapsed, ...variants?.collapsed },
  };

  return (
    <div
      className={cn(
        'overflow-hidden',
        variant === 'outline' && 'group-data-[state=open]:rounded-b-md',
        className,
      )}
    >
      <AnimatePresence initial={false}>
        {open && (
          <m.div
            id={uniqueId}
            initial="collapsed"
            animate="expanded"
            exit="collapsed"
            variants={combinedVariants}
            className={contentClassName}
          >
            {children}
          </m.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export type DisclosureBodyProps = {
  children: React.ReactNode;
  className?: string;
};

export function DisclosureBody({ children, className }: DisclosureBodyProps) {
  return <div className={cn('p-3 pt-0', className)}>{children}</div>;
}

export default {
  Disclosure,
  DisclosureBody,
  DisclosureProvider,
  DisclosureTrigger,
  DisclosureContent,
};
