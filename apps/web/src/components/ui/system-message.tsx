'use client';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { InfoIcon, WarningCircleIcon, WarningIcon } from '@phosphor-icons/react';
import { cva, type VariantProps } from 'class-variance-authority';
import React from 'react';

const systemMessageVariants = cva(
  'flex flex-row items-center gap-3 rounded-md border py-2 pr-2 pl-3',
  {
    variants: {
      variant: {
        action: 'text-muted-foreground',
        error: 'text-kortix-red',
        warning: 'text-kortix-orange',
      },
      fill: {
        true: 'border-transparent',
        false: '',
      },
    },
    compoundVariants: [
      { variant: 'action', fill: true, class: 'bg-muted' },
      { variant: 'error', fill: true, class: 'bg-kortix-red/10' },
      { variant: 'warning', fill: true, class: 'bg-kortix-orange/10' },
      { variant: 'action', fill: false, class: 'border-border' },
      { variant: 'error', fill: false, class: 'border-kortix-red/30' },
      { variant: 'warning', fill: false, class: 'border-kortix-orange/30' },
    ],
    defaultVariants: {
      variant: 'action',
      fill: false,
    },
  },
);

/** `cta.variant` is the caller-facing name; this maps it to a Button variant. */
const CTA_BUTTON_VARIANT = {
  solid: 'default',
  outline: 'outline',
  ghost: 'ghost',
} as const;

export type SystemMessageProps = React.ComponentProps<'div'> &
  VariantProps<typeof systemMessageVariants> & {
    icon?: React.ReactNode;
    isIconHidden?: boolean;
    cta?: {
      label: string;
      onClick?: () => void;
      variant?: keyof typeof CTA_BUTTON_VARIANT;
    };
  };

function defaultIcon(variant: SystemMessageProps['variant']) {
  switch (variant) {
    case 'error':
      return <WarningCircleIcon className="size-4" />;
    case 'warning':
      return <WarningIcon className="size-4" />;
    default:
      return <InfoIcon className="size-4" />;
  }
}

export function SystemMessage({
  children,
  variant = 'action',
  fill = false,
  icon,
  isIconHidden = false,
  cta,
  className,
  ...props
}: SystemMessageProps) {
  const iconToShow = isIconHidden ? null : (icon ?? defaultIcon(variant));

  return (
    <div className={cn(systemMessageVariants({ variant, fill }), className)} {...props}>
      <div className="flex min-w-0 flex-1 flex-row items-center gap-3 leading-normal">
        {iconToShow !== null && (
          <div className="flex h-[1lh] shrink-0 items-center justify-center self-start">
            {iconToShow}
          </div>
        )}
        <div className="min-w-0 flex-1 text-sm">{children}</div>
      </div>

      {cta && (
        <Button
          variant={CTA_BUTTON_VARIANT[cta.variant ?? 'solid']}
          size="sm"
          onClick={cta.onClick}
        >
          {cta.label}
        </Button>
      )}
    </div>
  );
}
