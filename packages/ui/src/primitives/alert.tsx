import { CheckCircleIcon, InfoIcon, WarningCircleIcon, WarningIcon, type Icon } from '@phosphor-icons/react';
import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';

import { cn } from '../lib/utils';

// The genui Callout, exactly (features/genui/components/inline.tsx, Paper Callout 14): the tone is the
// /15 fill and the solid 16px glyph; title and body stay ink. Tone type on a tone fill read ~2:1
// (Marko, 2026-09-03), so text never takes the hue.
const alertVariants = cva('flex w-full gap-2.5 rounded-lg px-3.5 py-2.5', {
  variants: {
    variant: {
      default: 'bg-kortix-blue/15',
      success: 'bg-kortix-green/15',
      warning: 'bg-kortix-orange/15',
      destructive: 'bg-kortix-red/15',
    },
  },
  defaultVariants: {
    variant: 'default',
  },
});

type AlertVariant = NonNullable<VariantProps<typeof alertVariants>['variant']>;

const ALERT_GLYPH: Record<AlertVariant, { icon: Icon; className: string }> = {
  default: { icon: InfoIcon, className: 'text-kortix-blue' },
  success: { icon: CheckCircleIcon, className: 'text-kortix-green' },
  warning: { icon: WarningIcon, className: 'text-kortix-orange' },
  destructive: { icon: WarningCircleIcon, className: 'text-kortix-red' },
};

/** Replaces the variant's glyph. Only for a state the glyph cannot say (a spinner while loading). */
function AlertMedia({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="alert-media"
      className={cn(
        // mt-0.5 centers a 16px glyph on the first 20px line, of the title or of the body.
        'mt-0.5 flex shrink-0 self-start [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
        className,
      )}
      {...props}
    />
  );
}

function AlertContent({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="alert-content"
      className={cn('flex min-w-0 flex-1 flex-col text-sm', className)}
      {...props}
    />
  );
}

function AlertTitle({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span data-slot="alert-title" className={cn('text-foreground font-[550]', className)} {...props} />
  );
}

function AlertDescription({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="item-description"
      className={cn(
        'text-foreground text-pretty',
        '[&>a:hover]:text-primary [&>a]:underline [&>a]:underline-offset-4',
        className,
      )}
      {...props}
    />
  );
}

function AlertActions({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="alert-actions"
      className={cn('flex shrink-0 items-center gap-2 self-center', className)}
      {...props}
    />
  );
}

function partitionAlertChildren(children: React.ReactNode) {
  const mediaChildren: React.ReactNode[] = [];
  const contentChildren: React.ReactNode[] = [];
  const actionChildren: React.ReactNode[] = [];

  React.Children.forEach(children, (child) => {
    if (React.isValidElement(child) && child.type === AlertMedia) mediaChildren.push(child);
    else if (React.isValidElement(child) && child.type === AlertActions) actionChildren.push(child);
    else if (child != null) contentChildren.push(child);
  });

  const hasContentWrapper = contentChildren.some(
    (child) => React.isValidElement(child) && child.type === AlertContent,
  );

  return { mediaChildren, contentChildren, actionChildren, hasContentWrapper };
}

function Alert({
  className,
  variant,
  children,
  ...props
}: React.ComponentProps<'div'> & VariantProps<typeof alertVariants>) {
  const { mediaChildren, contentChildren, actionChildren, hasContentWrapper } =
    partitionAlertChildren(children);
  const glyph = ALERT_GLYPH[variant ?? 'default'];

  return (
    <div
      role="alert"
      data-slot="alert"
      className={cn(alertVariants({ variant }), className)}
      {...props}
    >
      {mediaChildren.length > 0 ? (
        mediaChildren
      ) : (
        <glyph.icon
          data-slot="alert-glyph"
          className={cn('mt-0.5 size-4 shrink-0', glyph.className)}
          weight="fill"
          aria-hidden
        />
      )}
      {contentChildren.length > 0 &&
        (hasContentWrapper ? contentChildren : <AlertContent>{contentChildren}</AlertContent>)}
      {actionChildren}
    </div>
  );
}

export { Alert, AlertActions, AlertContent, AlertDescription, AlertMedia, AlertTitle };
