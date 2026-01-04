import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { isLocalMode } from '@/lib/config';
import { Button } from '@/components/ui/button';
import { TierBadge } from '@/components/billing/tier-badge';

const BADGE_ORDER = ['Ultra', 'Plus', 'Pro'] as const;

export interface UpgradePreviewProps {
    subscriptionData?: any;
    onClose?: () => void;
    onOpenUpgrade?: () => void;
    hasMultiple?: boolean;
    showIndicators?: boolean;
    currentIndex?: number;
    totalCount?: number;
    onIndicatorClick?: (index: number) => void;
}

export const UpgradePreview: React.FC<UpgradePreviewProps> = ({
    subscriptionData,
    onClose,
    onOpenUpgrade,
    hasMultiple = false,
    showIndicators = false,
    currentIndex = 0,
    totalCount = 1,
    onIndicatorClick,
}) => {
    const [currentBadge, setCurrentBadge] = useState(0);

    useEffect(() => {
        const interval = setInterval(() => {
            setCurrentBadge((prev) => (prev + 1) % 3);
        }, 1200);
        return () => clearInterval(interval);
    }, []);

    if (isLocalMode()) return null;

    return (
        <div className="flex items-center gap-3">
            {/* Single Tier Badge - cycling through plans */}
            <div className="flex-shrink-0 w-10 h-10 flex items-center justify-center relative ml-2">
                <AnimatePresence mode="wait">
                    <motion.div
                        key={BADGE_ORDER[currentBadge]}
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -8 }}
                        transition={{ duration: 0.2 }}
                        className="absolute"
                    >
                        <TierBadge planName={BADGE_ORDER[currentBadge]} size="xxs" />
                    </motion.div>
                </AnimatePresence>
            </div>

            {/* Content */}
            <div className="flex-1 min-w-0">
                <motion.div className="flex items-center gap-2 mb-0.5">
                    <h4 className="text-sm font-medium text-foreground truncate">
                        Unlock the full Kortix experience
                    </h4>
                </motion.div>

                <span className="text-xs text-muted-foreground truncate block">
                    Kortix Advanced mode, 100+ Integrations, Triggers, Custom AI Workers & more
                </span>
            </div>

            {/* Apple-style notification indicators - only for multiple notification types */}
            {showIndicators && totalCount > 1 && (
                <button
                    data-indicator-click
                    onClick={(e) => {
                        e.stopPropagation();
                        // For 2 notifications, toggle. For more, cycle through
                        const nextIndex = totalCount === 2
                            ? (currentIndex === 0 ? 1 : 0)
                            : (currentIndex + 1) % totalCount;
                        onIndicatorClick?.(nextIndex);
                    }}
                    className="flex items-center gap-1.5 mr-3 px-2 py-1.5 rounded-lg hover:bg-muted/30 transition-colors"
                >
                    {Array.from({ length: totalCount }).map((_, index) => (
                        <div
                            key={index}
                            className={cn(
                                "transition-all duration-300 ease-out rounded-full",
                                index === currentIndex
                                    ? "w-6 h-2 bg-foreground"
                                    : "w-3 h-2 bg-muted-foreground/40"
                            )}
                        />
                    ))}
                </button>
            )}

            <Button variant="ghost" size="icon" className="h-8 w-8 flex-shrink-0 hover:bg-muted/50" onClick={(e) => { e.stopPropagation(); onClose?.(); }}>
                <X className="h-4 w-4 text-muted-foreground hover:text-foreground transition-colors" />
            </Button>
        </div>
    );
};

