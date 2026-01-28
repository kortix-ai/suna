'use client';

import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Ticket, ArrowRight, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';
import { usePricingModalStore } from '@/stores/pricing-modal-store';
import { isLocalMode } from '@/lib/config';
import { TierBadge } from '@/components/billing/tier-badge';

const PLANS = ['Plus', 'Pro', 'Ultra'] as const;

export function UpgradeCTA() {
  const openPricingModal = usePricingModalStore((s) => s.openPricingModal);
  const [currentPlan, setCurrentPlan] = useState(0);
  const [isHovered, setIsHovered] = useState(false);

  useEffect(() => {
    const interval = setInterval(() => {
      setCurrentPlan((prev) => (prev + 1) % PLANS.length);
    }, 1800);
    return () => clearInterval(interval);
  }, []);

  if (isLocalMode()) return null;

  return (
    <motion.button
      onClick={() => openPricingModal()}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: 'easeOut' }}
      className={cn(
        'group relative flex items-center gap-3 w-full mt-4 p-3',
        'rounded-2xl border border-border',
        'bg-gradient-to-r from-muted/80 via-muted/40 to-muted/80',
        'hover:border-primary/30 hover:from-muted via-muted/60 hover:to-muted',
        'transition-all duration-300 cursor-pointer text-left',
        'overflow-hidden'
      )}
    >
      {/* Subtle animated shimmer on hover */}
      <motion.div
        className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-500"
        style={{
          background: 'linear-gradient(90deg, transparent 0%, rgba(var(--primary-rgb, 0 0 0) / 0.03) 50%, transparent 100%)',
          backgroundSize: '200% 100%',
        }}
        animate={isHovered ? { backgroundPosition: ['200% 0%', '-200% 0%'] } : {}}
        transition={{ duration: 1.5, ease: 'easeInOut', repeat: Infinity }}
      />

      {/* Left: Cycling tier badge */}
      <div className="relative flex-shrink-0 w-10 h-10 flex items-center justify-center">
        <AnimatePresence mode="wait">
          <motion.div
            key={PLANS[currentPlan]}
            initial={{ opacity: 0, scale: 0.8, y: 6 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.8, y: -6 }}
            transition={{ duration: 0.25, ease: 'easeOut' }}
            className="absolute"
          >
            <TierBadge planName={PLANS[currentPlan]} size="xs" />
          </motion.div>
        </AnimatePresence>
      </div>

      {/* Center: Content */}
      <div className="flex-1 min-w-0 flex flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-foreground">
            Upgrade & Save
          </span>
          <Sparkles className="w-3.5 h-3.5 text-amber-500" />
        </div>

        {/* Coupon ticket */}
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-muted-foreground">
            Use code
          </span>
          <span className={cn(
            'inline-flex items-center gap-1 px-1.5 py-0.5',
            'rounded-md bg-primary/10 border border-primary/20',
            'text-xs font-mono font-semibold text-primary',
            'tracking-wide'
          )}>
            KORTIX2026
          </span>
          <span className="text-xs text-muted-foreground">
            for
          </span>
          <span className="text-xs font-semibold text-foreground">
            30% off + 2X credits
          </span>
        </div>
      </div>

      {/* Right: Arrow CTA */}
      <motion.div
        className={cn(
          'flex-shrink-0 flex items-center justify-center',
          'w-8 h-8 rounded-xl',
          'bg-primary text-primary-foreground',
          'shadow-sm'
        )}
        animate={{ x: isHovered ? 2 : 0 }}
        transition={{ duration: 0.2 }}
      >
        <ArrowRight className="w-4 h-4" />
      </motion.div>
    </motion.button>
  );
}

// Regex to match <upgrade_cta .../> tags
const UPGRADE_CTA_REGEX = /<upgrade_cta\s*(?:recommended_plan=["']?(?:plus|pro)["']?)?\s*\/?>/gi;

/**
 * Extracts upgrade CTA tags from content and returns clean content + whether CTA was found
 */
export function extractUpgradeCTA(content: string): {
  cleanContent: string;
  hasCTA: boolean;
} {
  let hasCTA = false;

  const cleanContent = content.replace(UPGRADE_CTA_REGEX, () => {
    hasCTA = true;
    return '';
  });

  return {
    cleanContent: cleanContent.trim(),
    hasCTA,
  };
}
