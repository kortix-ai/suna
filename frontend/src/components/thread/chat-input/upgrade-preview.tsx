import React from 'react';
import { motion } from 'framer-motion';
import { X, Crown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { isLocalMode } from '@/lib/config';
import { Button } from '@/components/ui/button';

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
            {/* Icon */}
            <div className="flex-shrink-0">
                <motion.div
                    className={cn(
                        "w-10 h-10 rounded-2xl flex items-center justify-center",
                        "bg-gradient-to-br from-yellow-50 to-orange-50 dark:from-yellow-900/20 dark:to-orange-900/20 border border-yellow-200 dark:border-yellow-800"
                    )}
                >
                    <Crown className="h-5 w-5 text-yellow-600 dark:text-yellow-400" />
                </motion.div>
            </div>

            {/* Content */}
            <div className="flex-1 min-w-0">
                <motion.div className="flex items-center gap-2 mb-1">
                    <h4 className="text-sm font-medium text-foreground truncate">
                        Upgrade now to get the full Kortix experience
                    </h4>
                </motion.div>

                <motion.div className="flex items-center gap-2">
                    <div className={cn(
                        "w-2 h-2 rounded-full bg-yellow-500"
                    )} />
                    <span className="text-xs text-muted-foreground truncate">
                        Unlock premium models & higher limits
                    </span>
                </motion.div>
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

