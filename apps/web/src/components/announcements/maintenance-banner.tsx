'use client';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { X, ExternalLink, Info, AlertTriangle, AlertCircle, Clock } from 'lucide-react';
import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { usePathname } from 'next/navigation';
import { normalizeAppPathname } from '@/lib/instance-routes';
import type { MaintenanceConfig, MaintenanceLevel } from '@/lib/maintenance-store';

interface MaintenanceBannerProps {
  config: MaintenanceConfig;
}

const levelConfig: Record<
  Exclude<MaintenanceLevel, 'none' | 'blocking'>,
  {
    icon: typeof Info;
    iconBg: string;
    iconBorder: string;
    iconColor: string;
    dismissible: boolean;
    defaultTitle: string;
  }
> = {
  info: {
    icon: Info,
    iconBg: 'bg-blue-500/10 dark:bg-blue-500/20',
    iconBorder: 'border-blue-500/20 dark:border-blue-500/30',
    iconColor: 'text-blue-500',
    dismissible: true,
    defaultTitle: 'Notice',
  },
  warning: {
    icon: AlertTriangle,
    iconBg: 'bg-amber-500/20 dark:bg-amber-500/20',
    iconBorder: 'border-amber-500/60 dark:border-amber-500/30',
    iconColor: 'text-amber-500',
    dismissible: true,
    defaultTitle: 'Scheduled Maintenance',
  },
  critical: {
    icon: AlertCircle,
    iconBg: 'bg-red-500/10 dark:bg-red-500/20',
    iconBorder: 'border-red-500/20 dark:border-red-500/30',
    iconColor: 'text-red-500',
    dismissible: false,
    defaultTitle: 'Service Disruption',
  },
};

export function MaintenanceBanner({ config }: MaintenanceBannerProps) {
  const [isDismissed, setIsDismissed] = useState(false);
  const [isMounted, setIsMounted] = useState(false);
  const [countdown, setCountdown] = useState<string>('');
  const pathname = normalizeAppPathname(usePathname());

  const isDashboardPage =
    pathname?.startsWith('/dashboard') ||
    pathname?.startsWith('/agents') ||
    pathname?.startsWith('/workspace') ||
    pathname?.startsWith('/projects') ||
    pathname?.startsWith('/settings') ||
    pathname === '/';

  const level = config.level;
  const lc = level !== 'none' && level !== 'blocking' ? levelConfig[level] : null;

  const dismissKey = `maintenance-dismissed-${config.updatedAt}`;

  useEffect(() => {
    setIsMounted(true);
    if (lc?.dismissible) {
      try {
        if (localStorage.getItem(dismissKey) === 'true') {
          setIsDismissed(true);
        }
      } catch {
        // ignore
      }
    }
  }, [dismissKey, lc?.dismissible]);

  // Countdown timer for scheduled maintenance
  useEffect(() => {
    if (!config.startTime || !config.endTime) return;

    const update = () => {
      const now = new Date();
      const start = new Date(config.startTime!);
      const end = new Date(config.endTime!);

      if (isNaN(start.getTime()) || isNaN(end.getTime())) return;

      if (now > end) {
        setCountdown('');
        return;
      }

      if (now >= start && now <= end) {
        const diff = end.getTime() - now.getTime();
        const h = Math.floor(diff / 3600000);
        const m = Math.floor((diff % 3600000) / 60000);
        setCountdown(h > 0 ? `${h}h ${m}m remaining` : m > 0 ? `${m}m remaining` : 'Almost done!');
      } else if (now < start) {
        const diff = start.getTime() - now.getTime();
        const d = Math.floor(diff / 86400000);
        const h = Math.floor((diff % 86400000) / 3600000);
        const m = Math.floor((diff % 3600000) / 60000);
        if (d > 0) setCountdown(`Starts in ${d}d ${h}h`);
        else if (h > 0) setCountdown(`Starts in ${h}h ${m}m`);
        else if (m > 0) setCountdown(`Starts in ${m}m`);
        else setCountdown('Starting soon');
      }
    };

    update();
    const interval = setInterval(update, 30000);
    return () => clearInterval(interval);
  }, [config.startTime, config.endTime]);

  // Don't render for none, blocking, or non-dashboard pages
  if (!lc || !isMounted || !isDashboardPage) return null;
  if (isDismissed && lc.dismissible) return null;

  const Icon = lc.icon;
  const title = config.title || lc.defaultTitle;

  const handleDismiss = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsDismissed(true);
    try {
      localStorage.setItem(dismissKey, 'true');
    } catch {
      // ignore
    }
  };

  const handleStatusClick = () => {
    if (!config.statusUrl) return;
    if (config.statusUrl.startsWith('http')) {
      window.open(config.statusUrl, '_blank', 'noopener,noreferrer');
    } else {
      window.location.href = config.statusUrl;
    }
  };

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, y: 40 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 40 }}
        transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
        className="fixed bottom-4 right-4 z-[110] w-[340px]"
      >
        <div className="relative bg-muted rounded-xl overflow-hidden border">
          {lc.dismissible && (
            <Button variant="ghost" size="icon-sm" onClick={handleDismiss} className="absolute top-2 right-2 z-10">
              <X className="h-3 w-3 text-foreground dark:text-white" />
            </Button>
          )}

          <div
            className={cn(
              'p-4 bg-muted/50 dark:bg-[#161618] transition-colors',
              config.statusUrl && 'cursor-pointer hover:bg-muted dark:hover:bg-[#1a1a1c]',
            )}
            onClick={config.statusUrl ? handleStatusClick : undefined}
          >
            <div className="flex items-start gap-3">
              <div
                className={cn(
                  'w-12 h-12 rounded-xl border flex items-center justify-center flex-shrink-0',
                  lc.iconBg,
                  lc.iconBorder,
                )}
              >
                <Icon className={cn('h-5 w-5', lc.iconColor)} />
              </div>
              <div className="flex-1 min-w-0 pr-4">
                <h3 className="text-foreground dark:text-white text-sm font-semibold mb-1">
                  {title}
                </h3>
                <p className="text-muted-foreground dark:text-white/60 text-xs leading-relaxed line-clamp-2">
                  {config.message}
                </p>
                {countdown && (
                  <div className="mt-2 flex items-center gap-1.5 text-xs font-medium text-amber-600 dark:text-amber-400">
                    <Clock className="h-3 w-3" />
                    <span>{countdown}</span>
                  </div>
                )}
                {config.statusUrl && (
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={handleStatusClick}
                    className="mt-2"
                  >
                    View Status
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
