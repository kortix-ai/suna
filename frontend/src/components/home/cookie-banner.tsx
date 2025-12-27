'use client';

import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Cookie, X } from 'lucide-react';
import Link from 'next/link';
import { cn } from '@/lib/utils';
import { isInGDPRRegion } from '@/lib/utils/geo-detection';

const COOKIE_CONSENT_KEY = 'cookie-consent-accepted';

export function CookieBanner() {
  const [isVisible, setIsVisible] = useState(false);
  const [isClosing, setIsClosing] = useState(false);

  useEffect(() => {
    // Only show cookie banner in GDPR regions (EU, UK, Brazil, etc.)
    if (!isInGDPRRegion()) {
      return;
    }
    
    // Check if user has already accepted cookies
    const hasAccepted = localStorage.getItem(COOKIE_CONSENT_KEY);
    if (!hasAccepted) {
      // Small delay before showing for better UX
      const timer = setTimeout(() => setIsVisible(true), 1500);
      return () => clearTimeout(timer);
    }
  }, []);

  const handleAccept = () => {
    setIsClosing(true);
    localStorage.setItem(COOKIE_CONSENT_KEY, 'true');
    setTimeout(() => setIsVisible(false), 300);
  };

  const handleDecline = () => {
    setIsClosing(true);
    localStorage.setItem(COOKIE_CONSENT_KEY, 'declined');
    setTimeout(() => setIsVisible(false), 300);
  };

  return (
    <AnimatePresence>
      {isVisible && (
        <motion.div
          initial={{ opacity: 0, y: 100, scale: 0.95 }}
          animate={{ 
            opacity: isClosing ? 0 : 1, 
            y: isClosing ? 100 : 0, 
            scale: isClosing ? 0.95 : 1 
          }}
          exit={{ opacity: 0, y: 100, scale: 0.95 }}
          transition={{ 
            type: 'spring', 
            damping: 25, 
            stiffness: 300,
            duration: 0.4 
          }}
          className="fixed bottom-4 left-4 right-4 md:left-auto md:right-6 md:bottom-6 z-50 md:max-w-md"
        >
          <div 
            className={cn(
              "relative overflow-hidden rounded-[16px]",
              "bg-gradient-to-br from-background/95 via-background/98 to-background",
              "backdrop-blur-xl border border-border/50",
              "shadow-[0_8px_32px_rgba(0,0,0,0.12),0_2px_8px_rgba(0,0,0,0.08)]",
              "dark:shadow-[0_8px_32px_rgba(0,0,0,0.4),0_2px_8px_rgba(0,0,0,0.2)]"
            )}
          >
            {/* Subtle gradient accent */}
            <div className="absolute inset-0 bg-gradient-to-br from-primary/[0.03] via-transparent to-primary/[0.02] pointer-events-none" />
            
            {/* Content */}
            <div className="relative p-5">
              <div className="flex items-start gap-4">
                {/* Cookie icon - brown/cookie colored */}
                <div className="flex-shrink-0 mt-0.5">
                  <div className="flex items-center justify-center w-10 h-10 rounded-[16px] bg-gradient-to-br from-amber-800/10 to-yellow-900/10 dark:from-amber-700/20 dark:to-yellow-800/20 border border-amber-900/10 dark:border-amber-600/20">
                    <Cookie className="w-5 h-5 text-amber-800 dark:text-amber-500" />
                  </div>
                </div>

                {/* Text content */}
                <div className="flex-1 min-w-0">
                  <h3 className="text-sm font-semibold text-foreground mb-1.5">
                    Fresh cookies, anyone?
                  </h3>
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    We bake cookies to make your experience even sweeter.{' '}
                    <Link 
                      href="/legal?tab=privacy" 
                      className="text-foreground/80 hover:text-foreground underline underline-offset-2 transition-colors"
                    >
                      See the recipe
                    </Link>
                  </p>
                </div>

                {/* Close button */}
                <button
                  onClick={handleDecline}
                  className="flex-shrink-0 p-1.5 -m-1.5 rounded-lg text-muted-foreground/60 hover:text-muted-foreground hover:bg-muted/50 transition-all"
                  aria-label="Decline cookies"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* Action buttons */}
              <div className="flex items-center gap-2 mt-4">
                <button
                  onClick={handleDecline}
                  className={cn(
                    "flex-1 px-4 py-2 text-xs font-medium rounded-lg",
                    "text-muted-foreground hover:text-foreground",
                    "bg-muted/50 hover:bg-muted",
                    "border border-transparent hover:border-border/50",
                    "transition-all duration-200"
                  )}
                >
                  No thanks
                </button>
                <button
                  onClick={handleAccept}
                  className={cn(
                    "flex-1 px-4 py-2 text-xs font-medium rounded-lg",
                    "text-primary-foreground",
                    "bg-primary hover:bg-primary/90",
                    "shadow-[inset_0_1px_2px_rgba(255,255,255,0.15),0_2px_4px_rgba(0,0,0,0.1)]",
                    "border border-white/[0.08]",
                    "transition-all duration-200"
                  )}
                >
                  Accept
                </button>
              </div>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

