'use client';

import {
  Alert,
  AlertActions,
  AlertDescription,
  AlertMedia,
  AlertTitle,
} from '@/components/ui/alert';
import { STATUS_BG, STATUS_BORDER, STATUS_TEXT, type StatusTone } from '@/components/ui/status';
import { cn } from '@/lib/utils';
import * as React from 'react';

export type InfoBannerIcon =
  | React.ComponentType<{ className?: string }>
  | React.ReactElement<{ className?: string }>;

function renderBannerIcon(icon: InfoBannerIcon, className: string): React.ReactNode {
  if (React.isValidElement(icon)) {
    return React.cloneElement(icon, {
      className: cn(className, icon.props.className),
    });
  }

  const IconComponent = icon;
  return <IconComponent className={className} />;
}

type AlertVariant = NonNullable<React.ComponentProps<typeof Alert>['variant']>;

const TONE_TO_ALERT_VARIANT: Record<StatusTone, AlertVariant> = {
  neutral: 'default',
  info: 'default',
  success: 'default',
  warning: 'warning',
  destructive: 'destructive',
};

const TONE_SURFACE: Partial<Record<StatusTone, string>> = {
  neutral: cn(STATUS_BORDER.neutral, STATUS_BG.neutral),
  info: cn(STATUS_BORDER.info, STATUS_BG.info),
  success: cn(STATUS_BORDER.success, STATUS_BG.success),
};

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
  const usesAlertToneVariant = safeTone === 'warning' || safeTone === 'destructive';
  const iconClassName = cn('size-[1.1rem]', !usesAlertToneVariant && STATUS_TEXT[safeTone]);

  return (
    <Alert
      variant={TONE_TO_ALERT_VARIANT[safeTone]}
      className={cn(TONE_SURFACE[safeTone], className)}
      {...props}
    >
      {icon != null && <AlertMedia>{renderBannerIcon(icon, iconClassName)}</AlertMedia>}
      {title != null && <AlertTitle>{title}</AlertTitle>}
      {children != null && <AlertDescription className="font-medium">{children}</AlertDescription>}
      {action != null && <AlertActions>{action}</AlertActions>}
    </Alert>
  );
}
