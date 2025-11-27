import React from 'react';
import { motion } from 'framer-motion';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { isLocalMode } from '@/lib/config';
import { Button } from '@/components/ui/button';
import { TierBadge } from '@/components/billing/tier-badge';

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
    if (isLocalMode()) return null;

    return (
        <div className="flex items-center gap-3">
            {/* Stacked Tier Badges - vertical stack with Ultra on top */}
            <div className="flex-shrink-0 flex flex-col items-center justify-center">
            <div className="mb-[-6px] z-30">
        <TierBadge planName="Ultra" size="xxs" />
    </div>
    <div className="mb-[-6px] z-20">
        <TierBadge planName="Plus" size="xxs" />
    </div>
    <div className=" z-10">
        <TierBadge planName="Pro" size="xxs" />
    </div>
            </div>

            {/* Content */}
            <div className="flex-1 min-w-0">
                <motion.div className="flex items-center gap-2 mb-0.5">
                    <h4 className="text-sm font-medium text-foreground truncate">
                        Unlock the full Kortix experience
                    </h4>
                </motion.div>

                <span className="text-xs text-muted-foreground truncate block">
                    Kortix Power mode, 100+ Integrations, Triggers, Custom AI Workers & more
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

