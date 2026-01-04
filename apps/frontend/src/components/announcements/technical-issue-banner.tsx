'use client';

import { AlertTriangle, ExternalLink, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { usePathname } from 'next/navigation';

interface TechnicalIssueBannerProps {
  message: string;
  statusUrl?: string;
}


export function TechnicalIssueBanner({
  message,
  statusUrl,
}: TechnicalIssueBannerProps) {
  const [isDismissed, setIsDismissed] = useState(false);
  const [isMounted, setIsMounted] = useState(false);
  const pathname = usePathname();
  const isDashboardPage = pathname?.startsWith('/dashboard') ?? false

  const dismissKey = `technical-issue-dismissed-${message}`;

  useEffect(() => {
    setIsMounted(true);
    const dismissed = localStorage.getItem(dismissKey);
    if (dismissed === 'true') {
      setIsDismissed(true);
    }
  }, [dismissKey]);

  const handleDismiss = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsDismissed(true);
    localStorage.setItem(dismissKey, 'true');
  };

  const handleStatusClick = () => {
    if (statusUrl) {
      window.open(statusUrl, '_blank', 'noopener,noreferrer');
    }
  };

  if (!isMounted || isDismissed || !isDashboardPage) {
    return null;
  }

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, y: 40 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 40 }}
        transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
        className="fixed bottom-4 right-4 z-[100] w-[320px]"
      >
        <div className="relative bg-muted rounded-xl overflow-hidden border">
          <button
            onClick={handleDismiss}
            className="absolute top-2 right-2 z-10 w-6 h-6 flex items-center justify-center rounded-full bg-black/10 hover:bg-black/20 dark:bg-black/80 dark:hover:bg-black transition-colors"
          >
            <X className="h-3 w-3 text-foreground dark:text-white" />
          </button>

          <div 
            className="p-4 bg-muted/50 dark:bg-[#161618] cursor-pointer hover:bg-muted dark:hover:bg-[#1a1a1c] transition-colors"
            onClick={handleStatusClick}
          >
            <div className="flex items-start gap-3">
              <div className="w-12 h-12 bg-destructive/10 dark:bg-destructive/20 rounded-xl border border-destructive/20 dark:border-destructive/30 flex items-center justify-center flex-shrink-0">
                <AlertTriangle className="h-5 w-5 text-destructive" />
              </div>
              <div className="flex-1 min-w-0 pr-4">
                <h3 className="text-foreground dark:text-white text-sm font-semibold mb-1">
                  Technical Issue
                </h3>
                <p className="text-muted-foreground dark:text-white/60 text-xs leading-relaxed line-clamp-2">
                  {message}
                </p>
                {statusUrl && (
                  <button
                    onClick={handleStatusClick}
                    className="flex items-center gap-1 mt-2 text-xs font-medium text-foreground dark:text-white hover:opacity-80 transition-opacity"
                  >
                    View Status
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
