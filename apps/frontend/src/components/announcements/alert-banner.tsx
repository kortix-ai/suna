'use client';

import { X, ExternalLink, LucideIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { usePathname } from 'next/navigation';

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
    iconBg: 'bg-amber-500/20 dark:bg-amber-500/20',
    iconBorder: 'border-amber-500/60 dark:border-amber-500/30',
    iconColor: 'text-amber-500',
  },
  error: {
    iconBg: 'bg-destructive/10 dark:bg-destructive/20',
    iconBorder: 'border-destructive/20 dark:border-destructive/30',
    iconColor: 'text-destructive',
  },
  info: {
    iconBg: 'bg-blue-500/10 dark:bg-blue-500/20',
    iconBorder: 'border-blue-500/20 dark:border-blue-500/30',
    iconColor: 'text-blue-500',
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
  const pathname = usePathname();
  const isDashboardPage = pathname?.startsWith('/dashboard') || pathname?.startsWith('/agents') || pathname?.startsWith('/projects') || pathname?.startsWith('/settings') || pathname === '/';

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
        className="fixed bottom-4 right-4 z-[100] w-[340px]"
      >
        <div className="relative bg-muted rounded-xl overflow-hidden border">
          <button
            onClick={handleDismiss}
            className="absolute top-2 right-2 z-10 w-6 h-6 flex items-center justify-center rounded-full bg-black/10 hover:bg-black/20 dark:bg-black/80 dark:hover:bg-black transition-colors"
          >
            <X className="h-3 w-3 text-foreground dark:text-white" />
          </button>

          <div 
            className={`p-4 bg-muted/50 dark:bg-[#161618] ${statusUrl ? 'cursor-pointer hover:bg-muted dark:hover:bg-[#1a1a1c]' : ''} transition-colors`}
            onClick={statusUrl ? handleStatusClick : undefined}
          >
            <div className="flex items-start gap-3">
              <div className={`w-12 h-12 ${styles.iconBg} rounded-xl border ${styles.iconBorder} flex items-center justify-center flex-shrink-0`}>
                <Icon className={`h-5 w-5 ${styles.iconColor}`} />
              </div>
              <div className="flex-1 min-w-0 pr-4">
                <h3 className="text-foreground dark:text-white text-sm font-semibold mb-1">
                  {title}
                </h3>
                <p className="text-muted-foreground dark:text-white/60 text-xs leading-relaxed line-clamp-2">
                  {message}
                </p>
                {countdown && (
                  <div className="mt-2">
                    {countdown}
                  </div>
                )}
                {statusUrl && (
                  <button
                    onClick={handleStatusClick}
                    className="flex items-center gap-1 mt-2 text-xs font-medium text-foreground dark:text-white hover:opacity-80 transition-opacity"
                  >
                    {statusLabel}
                    <ExternalLink className="h-3 w-3" />
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
