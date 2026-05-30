'use client';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { X, ExternalLink, LucideIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { usePathname } from 'next/navigation';
import { normalizeAppPathname } from '@/lib/instance-routes';

export type AlertBannerVariant = 'warning' | 'error' | 'info';

interface AlertBannerProps {
  title: string;
  message: string;
  variant?: AlertBannerVariant;
  icon: LucideIcon;
  dismissKey: string;
  statusUrl?: string;
  statusLabel?: string;
  countdown?: React.ReactNode;
  onDismiss?: () => void;
}

const variantStyles: Record<AlertBannerVariant, { 
  iconBg: string; 
  iconBorder: string; 
  iconColor: string;
}> = {
  warning: {
    iconBg: 'bg-amber-500/10',
    iconBorder: 'border-amber-500/30',
    iconColor: 'text-amber-600 dark:text-amber-400',
  },
  error: {
    iconBg: 'bg-muted',
    iconBorder: 'border-border/40',
    iconColor: 'text-muted-foreground',
  },
  info: {
    iconBg: 'bg-blue-500/10',
    iconBorder: 'border-blue-500/25',
    iconColor: 'text-blue-600 dark:text-blue-400',
  },
};

export function AlertBanner({
  title,
  message,
  variant = 'error',
  icon: Icon,
  dismissKey,
  statusUrl,
  statusLabel = 'View Status',
  countdown,
  onDismiss,
}: AlertBannerProps) {
  const [isDismissed, setIsDismissed] = useState(false);
  const [isMounted, setIsMounted] = useState(false);
  const pathname = normalizeAppPathname(usePathname());
  const isDashboardPage = pathname?.startsWith('/agents') || pathname?.startsWith('/workspace') || pathname?.startsWith('/projects') || pathname?.startsWith('/settings') || pathname === '/';

  const storageKey = `alert-dismissed-${dismissKey}`;

  useEffect(() => {
    setIsMounted(true);
    try {
      const dismissed = localStorage.getItem(storageKey);
      if (dismissed === 'true') {
        setIsDismissed(true);
      }
    } catch {
    }
  }, [storageKey]);

  const handleDismiss = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsDismissed(true);
    try {
      localStorage.setItem(storageKey, 'true');
    } catch {
    }
    onDismiss?.();
  };

  const handleStatusClick = () => {
    if (statusUrl) {
      if (statusUrl.startsWith('http')) {
        window.open(statusUrl, '_blank', 'noopener,noreferrer');
      } else {
        window.location.href = statusUrl;
      }
    }
  };

  if (!isMounted || isDismissed || !isDashboardPage) {
    return null;
  }

  const styles = variantStyles[variant];

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, y: 40 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 40 }}
        transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
        className="fixed bottom-4 right-4 z-[110] w-[340px]"
      >
        <div className="relative bg-muted rounded-2xl overflow-hidden border">
          <Button variant="ghost" size="icon-sm" onClick={handleDismiss}>
<X className="h-3 w-3 text-foreground" />

</Button>

          <div
            className={`p-4 bg-muted/50 ${statusUrl ? 'cursor-pointer hover:bg-muted' : ''} transition-colors`}
            onClick={statusUrl ? handleStatusClick : undefined}
          >
            <div className="flex items-start gap-3">
              <div className={`w-12 h-12 ${styles.iconBg} rounded-2xl border ${styles.iconBorder} flex items-center justify-center flex-shrink-0`}>
                <Icon className={cn('h-5 w-5', styles.iconColor)} />
              </div>
              <div className="flex-1 min-w-0 pr-4">
                <h3 className="text-foreground text-sm font-semibold mb-1">
                  {title}
                </h3>
                <p className="text-muted-foreground text-xs leading-relaxed line-clamp-2">
                  {message}
                </p>
                {countdown && (
                  <div className="mt-2">
                    {countdown}
                  </div>
                )}
                {statusUrl && (
                  <Button variant="ghost" size="icon-xs" onClick={handleStatusClick}>
{statusLabel}
                    <ExternalLink className="h-3 w-3" />
</Button>
                )}
              </div>
            </div>
          </div>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
