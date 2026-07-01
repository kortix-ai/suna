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
  | React.ComponentType<{ className?: string; strokeWidth?: number }>
  | React.ReactElement<{ className?: string; strokeWidth?: number }>;

const infoBannerVariants = cva(
  'text-foreground bg-popover flex flex-wrap items-center gap-4 px-4 py-3 text-sm',
  {
    variants: {
      tone: {
        neutral: 'border-border border ',
        info: 'border-kortix-yellow/25 ',
        success: 'border-kortix-green/25 ',
        warning: 'border-kortix-orange/25 ',
        destructive: 'border-border border',
      },
    },
    defaultVariants: {
      tone: 'neutral',
    },
  },
);

/** Status icon tile — mirrors the sandbox template state indicator. */
const infoBannerMediaVariants = cva(
  'inline-flex size-10 shrink-0 items-center justify-center self-start rounded-sm border [&_svg]:pointer-events-none [&_svg]:shrink-0',
  {
    variants: {
      tone: {
        neutral: 'text-muted-foreground border-border',
        info: 'bg-kortix-yellow/10 text-kortix-yellow',
        success: 'bg-kortix-green/10 text-kortix-green',
        warning: 'bg-kortix-orange/10 text-kortix-orange',
        destructive: 'bg-kortix-red/10 text-kortix-red',
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
      strokeWidth: icon.props.strokeWidth ?? 1.25,
    });
  }

  const IconComponent = icon;
  return <IconComponent className={className} strokeWidth={1.25} />;
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
        <AlertTitle className="text-foreground w-full max-w-full">{title}</AlertTitle>
      )}
      {children != null && <AlertDescription>{children}</AlertDescription>}
      {action != null && <AlertActions>{action}</AlertActions>}
    </Alert>
  );
}
