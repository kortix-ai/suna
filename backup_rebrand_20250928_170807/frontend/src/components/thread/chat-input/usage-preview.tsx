import React from 'react';
import { motion } from 'framer-motion';
import { X, Zap } from 'lucide-react';
import { cn } from '@/lib/utils';
import { isLocalMode } from '@/lib/config';
import { Button } from '@/components/ui/button';

export interface UsagePreviewProps {
    type: 'tokens' | 'upgrade';
    subscriptionData?: any;
    onClose?: () => void;
    onOpenUpgrade?: () => void;
    hasMultiple?: boolean;
    showIndicators?: boolean;
    currentIndex?: number;
    totalCount?: number;
    onIndicatorClick?: (index: number) => void;
}

export const UsagePreview: React.FC<UsagePreviewProps> = ({
    type,
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

    const formatCurrency = (amount: number) => {
        return `$${amount.toFixed(2)}`;
    };

    const getUsageDisplay = () => {
        if (!subscriptionData) return 'Loading usage...';

        const current = subscriptionData.current_usage || 0;
        const limit = subscriptionData.cost_limit || 0;

        if (limit === 0) return 'No usage limit set';

        const isOverLimit = current > limit;
        const usageText = `${formatCurrency(current)} / ${formatCurrency(limit)}`;

        if (isOverLimit) {
            return `${usageText} (over limit)`;
        }

        return usageText;
    };

    const isOverLimit = () => {
        if (!subscriptionData) return false;
        const current = subscriptionData.current_usage || 0;
        const limit = subscriptionData.cost_limit || 0;
        return current > limit;
    };

    return (
        <div className="flex items-center gap-3">
            {/* Icon */}
            <div className="flex-shrink-0">
                <motion.div
                    className={cn(
                        "w-10 h-10 rounded-2xl flex items-center justify-center",
                        isOverLimit()
                            ? "bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800"
                            : "bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800"
                    )}
                >
                    <Zap className={cn(
                        "h-5 w-5",
                        isOverLimit()
                            ? "text-red-500 dark:text-red-400"
                            : "text-blue-500 dark:text-blue-400"
                    )} />
                </motion.div>
            </div>

            {/* Content */}
            <div className="flex-1 min-w-0">
                <motion.div className="flex items-center gap-2 mb-1">
                    <h4 className="text-sm font-medium text-foreground truncate">
                        Upgrade for the best AI Models & more usage
                    </h4>
                </motion.div>

                <motion.div className="flex items-center gap-2">
                    <div className={cn(
                        "w-2 h-2 rounded-full",
                        isOverLimit() ? "bg-red-500" : "bg-blue-500"
                    )} />
                    <span className="text-xs text-muted-foreground truncate">
                        {getUsageDisplay()}
                    </span>
                </motion.div>
            </div>

            {/* Apple-style notification indicators - only for multiple notification types */}
            {showIndicators && totalCount === 2 && (
                <button
                    data-indicator-click
                    onClick={(e) => {
                        e.stopPropagation();
                        const nextIndex = currentIndex === 0 ? 1 : 0;
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