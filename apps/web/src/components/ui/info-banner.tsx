'use client';

import {
  Alert,
  AlertActions,
  AlertDescription,
  AlertMedia,
  AlertTitle,
} from '@/components/ui/alert';
import { type StatusTone } from '@/components/ui/status';
import { cn } from '@/lib/utils';
import { cva } from 'class-variance-authority';
import * as React from 'react';

export type InfoBannerIcon =
  React.ComponentType<{ className?: string }> | React.ReactElement<{ className?: string }>;

/**
 * Tone is carried by a /15 fill and the icon, never by the text. The 25% fill
 * with a solid-tone title it replaced (Marko, 2026-09-03: "never readable on
 * the core component") put orange type on a beige ground at ~2:1. Text is
 * foreground on every tone. A filled banner has no border color: one boundary,
 * a fill or a hairline, never both (color.md). Hues follow D5: info = blue,
 * success = green, warning = orange, destructive = red.
 */
const infoBannerVariants = cva('flex flex-wrap items-center gap-2 border px-2.5 py-2 text-sm', {
  variants: {
    tone: {
      neutral: 'border-border',
      info: 'bg-kortix-blue/15 border-transparent',
      success: 'bg-kortix-green/15 border-transparent',
      warning: 'bg-kortix-orange/15 border-transparent',
      destructive: 'bg-kortix-red/15 border-transparent',
    },
  },
  defaultVariants: {
    tone: 'neutral',
  },
});

/** The title is always foreground — the tone is the fill and the icon. */
const infoBannerTitleVariants = cva('text-foreground w-full max-w-full font-medium', {
  variants: {
    tone: {
      neutral: '',
      info: '',
      success: '',
      warning: '',
      destructive: '',
    },
  },
  defaultVariants: {
    tone: 'neutral',
  },
});

/** Status icon tile — mirrors the sandbox template state indicator. */
const infoBannerMediaVariants = cva(
  'inline-flex size-7 shrink-0 items-center justify-center self-start [&_svg]:pointer-events-none [&_svg]:shrink-0',
  {
    variants: {
      tone: {
        neutral: 'text-muted-foreground border-border',
        info: 'text-kortix-blue',
        success: 'text-kortix-green',
        warning: 'text-kortix-orange',
        destructive: 'text-kortix-red',
      },
    },
    defaultVariants: {
      tone: 'neutral',
    },
  },
);

const infoBannerIconVariants = cva('size-6 shrink-0');

function renderBannerIcon(icon: InfoBannerIcon, className: string): React.ReactNode {
  if (React.isValidElement(icon)) {
    return React.cloneElement(icon, {
      className: cn(className, icon.props.className),
    });
  }

  const IconComponent = icon;
  return <IconComponent className={className} />;
}

export interface InfoBannerProps extends Omit<React.ComponentProps<'div'>, 'title'> {
  tone?: StatusTone;
  icon?: InfoBannerIcon;
  title?: React.ReactNode;
  action?: React.ReactNode;
}

export function InfoBanner({
  tone = 'neutral',
  icon,
  title,
  action,
  className,
  children,
  ...props
}: InfoBannerProps) {
  const safeTone = tone ?? 'neutral';

  return (
    <Alert
      variant="default"
      className={cn(infoBannerVariants({ tone: safeTone }), className)}
      {...props}
    >
      {icon != null && (
        <AlertMedia className={infoBannerMediaVariants({ tone: safeTone })}>
          {renderBannerIcon(icon, infoBannerIconVariants())}
        </AlertMedia>
      )}

      {title != null && (
        <AlertTitle className={infoBannerTitleVariants({ tone: safeTone })}>{title}</AlertTitle>
      )}
      {children != null && (
        <AlertDescription className="text-muted-foreground">{children}</AlertDescription>
      )}
      {action != null && <AlertActions>{action}</AlertActions>}
    </Alert>
  );
}
