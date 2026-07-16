'use client';

import { useTranslations } from 'next-intl';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { X, ExternalLink, Info, AlertTriangle, AlertCircle, Clock } from 'lucide-react';
import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { usePathname } from 'next/navigation';
import { normalizeAppPathname } from '@kortix/sdk/instance-routes';
import { useAdminRole } from '@/hooks/admin/use-admin-role';
import type { MaintenanceConfig, MaintenanceLevel } from '@/lib/maintenance-store';

interface MaintenanceBannerProps {
  config: MaintenanceConfig;
}

// Per-level styling — brand tokens only (kortix-*), mirroring the InfoBanner tone
// scale so a system banner reads the same as every other alert in the app. The
// card border is tinted to the level so severity is legible before you read a word.
const levelConfig: Record<
  Exclude<MaintenanceLevel, 'none' | 'blocking'>,
  {
    icon: typeof Info;
    /** Tinted icon-tile classes (bg + foreground). */
    tile: string;
    /** Tone-tinted card border. */
    border: string;
    dismissible: boolean;
    defaultTitle: string;
  }
> = {
  info: {
    icon: Info,
    tile: 'bg-kortix-blue/10 text-kortix-blue',
    border: 'border-kortix-blue/25',
    dismissible: true,
    defaultTitle: 'Notice',
  },
  warning: {
    icon: AlertTriangle,
    tile: 'bg-kortix-orange/10 text-kortix-orange',
    border: 'border-kortix-orange/25',
    dismissible: true,
    defaultTitle: 'Scheduled maintenance',
  },
  critical: {
    icon: AlertCircle,
    tile: 'bg-kortix-red/10 text-kortix-red',
    border: 'border-kortix-red/25',
    dismissible: false,
    defaultTitle: 'Service disruption',
  },
};

export function MaintenanceBanner({ config }: MaintenanceBannerProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const [isDismissed, setIsDismissed] = useState(false);
  const [isMounted, setIsMounted] = useState(false);
  const [countdown, setCountdown] = useState<string>('');
  const pathname = normalizeAppPathname(usePathname());
  const { data: adminRole } = useAdminRole();
  const isAdmin = adminRole?.isAdmin === true;

  // Show the banner app-wide (dashboard + marketing) so a system notice reaches
  // everyone, not just a handful of routes. Only suppress it where it would be
  // redundant or in the way: the dedicated /maintenance lockdown page and the
  // auth flow. `blocking` already redirects to /maintenance via middleware.
  const isSuppressedPath =
    !!pathname && (pathname.startsWith('/maintenance') || pathname.startsWith('/auth'));

  const level = config.level;
  const lc = level !== 'none' && level !== 'blocking' ? levelConfig[level] : null;

  // Admins can always dismiss/bypass any banner — including the normally
  // non-dismissible `critical` level — so a system notice never traps them.
  const canDismiss = (lc?.dismissible ?? false) || isAdmin;

  const dismissKey = `maintenance-dismissed-${config.updatedAt}`;

  useEffect(() => {
    setIsMounted(true);
    if (canDismiss) {
      try {
        if (localStorage.getItem(dismissKey) === 'true') {
          setIsDismissed(true);
        }
      } catch {
        // ignore
      }
    }
  }, [dismissKey, canDismiss]);

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

  const handleDismiss = () => {
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

  // Render nothing (but keep AnimatePresence mounted so a dismiss animates out)
  // for none/blocking levels, before hydration, on suppressed paths, or once
  // dismissed.
  const shouldRender = !!lc && isMounted && !isSuppressedPath && !(isDismissed && canDismiss);
  const Icon = lc?.icon ?? Info;
  const title = config.title || lc?.defaultTitle || '';

  return (
    <AnimatePresence>
      {shouldRender && lc && (
        <motion.div
          key="maintenance-banner"
          initial={{ opacity: 0, y: 24, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 12 }}
          transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
          className="fixed right-4 bottom-4 z-[110] w-[360px] max-w-[calc(100vw-2rem)]"
        >
          <div
            className={cn(
              'bg-background relative flex items-start gap-3 rounded-[0.64rem] border p-4 shadow-lg',
              lc.border,
            )}
          >
            <span
              className={cn(
                'flex size-10 shrink-0 items-center justify-center rounded-sm border',
                lc.tile,
              )}
            >
              <Icon className="size-5" />
            </span>

            <div className={cn('min-w-0 flex-1', canDismiss && 'pr-6')}>
              <h3 className="text-foreground text-sm font-semibold text-balance">{title}</h3>
              {config.message && (
                <p className="text-muted-foreground mt-1 text-xs leading-relaxed text-pretty">
                  {config.message}
                </p>
              )}
              {countdown && (
                <div className="text-kortix-orange mt-2 flex items-center gap-1.5 text-xs font-medium tabular-nums">
                  <Clock className="size-3 shrink-0" />
                  <span>{countdown}</span>
                </div>
              )}
              {config.statusUrl && (
                <Button
                  variant="transparent"
                  size="sm"
                  onClick={handleStatusClick}
                  className="text-muted-foreground hover:text-foreground mt-2 h-auto gap-1 p-0 text-xs"
                >
                  {tHardcodedUi.raw(
                    'componentsAnnouncementsMaintenanceBanner.line201JsxTextViewStatus',
                  )}
                  <ExternalLink className="size-3" />
                </Button>
              )}
            </div>

            {canDismiss && (
              <button
                type="button"
                aria-label="Dismiss"
                onClick={handleDismiss}
                className="text-muted-foreground hover:text-foreground hover:bg-muted-foreground/10 absolute top-2.5 right-2.5 flex size-7 items-center justify-center rounded-md transition-colors active:scale-[0.96]"
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
