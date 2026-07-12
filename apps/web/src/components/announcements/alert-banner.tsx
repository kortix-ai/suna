'use client';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { X, ExternalLink, LucideIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { usePathname } from 'next/navigation';
import { normalizeAppPathname } from '@kortix/sdk/instance-routes';

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

// Tone → brand tokens (kortix-*), mirroring the InfoBanner / MaintenanceBanner
// scale so every floating alert in the app reads as one system. The card border
// is tinted to the tone so severity is legible at a glance.
const variantStyles: Record<AlertBannerVariant, { tile: string; border: string }> = {
  warning: { tile: 'bg-kortix-orange/10 text-kortix-orange', border: 'border-kortix-orange/25' },
  error: { tile: 'bg-kortix-red/10 text-kortix-red', border: 'border-kortix-red/25' },
  info: { tile: 'bg-kortix-blue/10 text-kortix-blue', border: 'border-kortix-blue/25' },
};

export function AlertBanner({
  title,
  message,
  variant = 'error',
  icon: Icon,
  dismissKey,
  statusUrl,
  statusLabel = 'View status',
  countdown,
  onDismiss,
}: AlertBannerProps) {
  const [isDismissed, setIsDismissed] = useState(false);
  const [isMounted, setIsMounted] = useState(false);
  const pathname = normalizeAppPathname(usePathname());
  const isDashboardPage =
    pathname?.startsWith('/agents') ||
    pathname?.startsWith('/workspace') ||
    pathname?.startsWith('/projects') ||
    pathname?.startsWith('/settings') ||
    pathname === '/';

  const storageKey = `alert-dismissed-${dismissKey}`;

  useEffect(() => {
    setIsMounted(true);
    try {
      if (localStorage.getItem(storageKey) === 'true') setIsDismissed(true);
    } catch {
      // ignore
    }
  }, [storageKey]);

  const handleDismiss = () => {
    setIsDismissed(true);
    try {
      localStorage.setItem(storageKey, 'true');
    } catch {
      // ignore
    }
    onDismiss?.();
  };

  const handleStatusClick = () => {
    if (!statusUrl) return;
    if (statusUrl.startsWith('http')) {
      window.open(statusUrl, '_blank', 'noopener,noreferrer');
    } else {
      window.location.href = statusUrl;
    }
  };

  // Keep AnimatePresence mounted so a dismiss animates out instead of hard-cutting.
  const shouldRender = isMounted && !isDismissed && isDashboardPage;
  const styles = variantStyles[variant];

  return (
    <AnimatePresence>
      {shouldRender && (
        <motion.div
          key="alert-banner"
          initial={{ opacity: 0, y: 24, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 12 }}
          transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
          className="fixed right-4 bottom-4 z-[110] w-[360px] max-w-[calc(100vw-2rem)]"
        >
          <div
            className={cn(
              'bg-background relative flex items-start gap-3 rounded-[0.64rem] border p-4 shadow-lg',
              styles.border,
            )}
          >
            <span
              className={cn(
                'flex size-10 shrink-0 items-center justify-center rounded-sm border',
                styles.tile,
              )}
            >
              <Icon className="size-5" />
            </span>

            <div className="min-w-0 flex-1 pr-6">
              <h3 className="text-foreground text-sm font-semibold text-balance">{title}</h3>
              {message && (
                <p className="text-muted-foreground mt-1 text-xs leading-relaxed text-pretty">
                  {message}
                </p>
              )}
              {countdown && <div className="mt-2">{countdown}</div>}
              {statusUrl && (
                <Button
                  variant="transparent"
                  size="sm"
                  onClick={handleStatusClick}
                  className="text-muted-foreground hover:text-foreground mt-2 h-auto gap-1 p-0 text-xs"
                >
                  {statusLabel}
                  <ExternalLink className="size-3" />
                </Button>
              )}
            </div>

            <button
              type="button"
              aria-label="Dismiss"
              onClick={handleDismiss}
              className="text-muted-foreground hover:text-foreground hover:bg-muted-foreground/10 absolute top-2.5 right-2.5 flex size-7 items-center justify-center rounded-md transition-colors active:scale-[0.96]"
            >
              <X className="size-3.5" />
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
