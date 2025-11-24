'use client';

import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { UsagePreview } from './usage-preview';
import { UpgradePreview } from './upgrade-preview';
import { FloatingToolPreview, ToolCallInput } from './floating-tool-preview';
import { isLocalMode } from '@/lib/config';

export interface ChatSnackProps {
    // Tool preview props
    toolCalls?: ToolCallInput[];
    toolCallIndex?: number;
    onExpandToolPreview?: () => void;
    agentName?: string;
    showToolPreview?: boolean;

    // Usage preview props
    showUsagePreview?: 'tokens' | 'upgrade' | false;
    subscriptionData?: any;
    onCloseUsage?: () => void;
    onOpenUpgrade?: () => void;

    // General props
    isVisible?: boolean;
}

const SNACK_LAYOUT_ID = 'chat-snack-float';
const SNACK_CONTENT_LAYOUT_ID = 'chat-snack-content';

export const ChatSnack: React.FC<ChatSnackProps> = ({
    toolCalls = [],
    toolCallIndex = 0,
    onExpandToolPreview,
    agentName,
    showToolPreview = false,
    showUsagePreview = false,
    subscriptionData,
    onCloseUsage,
    onOpenUpgrade,
    isVisible = false,
}) => {
    const [currentView, setCurrentView] = React.useState(0);
    const [userDismissedUpgrade, setUserDismissedUpgrade] = React.useState(false);

    // Check if user is on free tier - only when we have subscriptionData and can confirm it's free
    const isFreeTier = subscriptionData && (
        subscriptionData.tier_key === 'free' ||
        subscriptionData.tier?.name === 'free' ||
        subscriptionData.plan_name === 'free'
    );

    // Determine what notifications we have - match exact rendering conditions
    const notifications = [];

    // Tool notification: only if we have tool calls and showToolPreview is true
    if (showToolPreview && toolCalls.length > 0) {
        notifications.push('tool');
    }

    // Usage notification: must match ALL rendering conditions
    if (showUsagePreview && !isLocalMode() && subscriptionData) {
        notifications.push('usage');
    }

    // Upgrade notification: only for free tier users who haven't dismissed it (must have subscriptionData)
    if (isFreeTier && subscriptionData && !isLocalMode() && !userDismissedUpgrade && onOpenUpgrade) {
        notifications.push('upgrade');
    }



    const totalNotifications = notifications.length;
    const hasMultiple = totalNotifications > 1;

    // Reset currentView when notifications change
    React.useEffect(() => {
        if (currentView >= totalNotifications && totalNotifications > 0) {
            setCurrentView(0);
        }
    }, [totalNotifications, currentView]);

    // Update isVisible to include upgrade notification - only show if we have subscriptionData
    const shouldShowSnack = isVisible || (isFreeTier && subscriptionData && !isLocalMode() && !userDismissedUpgrade && onOpenUpgrade && totalNotifications > 0);
    
    // Auto-cycle through notifications
    React.useEffect(() => {
        if (!hasMultiple || !shouldShowSnack) return;

        const interval = setInterval(() => {
            setCurrentView((prev) => (prev + 1) % totalNotifications);
        }, 20000);

        return () => clearInterval(interval);
    }, [hasMultiple, shouldShowSnack, totalNotifications, currentView]); // Reset timer when currentView changes
    
    if (!shouldShowSnack || totalNotifications === 0) return null;

    const currentNotification = notifications[currentView];

    const renderContent = () => {
        if (currentNotification === 'tool' && showToolPreview) {
            return (
                <FloatingToolPreview
                    toolCalls={toolCalls}
                    currentIndex={toolCallIndex}
                    onExpand={onExpandToolPreview || (() => { })}
                    agentName={agentName}
                    isVisible={true}
                    showIndicators={hasMultiple}
                    indicatorIndex={currentView}
                    indicatorTotal={totalNotifications}
                    onIndicatorClick={(index) => setCurrentView(index)}
                />
            );
        }

        if (currentNotification === 'usage' && showUsagePreview && !isLocalMode()) {
            return (
                <motion.div
                    layoutId={SNACK_LAYOUT_ID}
                    layout
                    transition={{
                        layout: {
                            type: "spring",
                            stiffness: 300,
                            damping: 30
                        }
                    }}
                    className="-mb-4 w-full"
                    style={{ pointerEvents: 'auto' }}
                >
                    <motion.div
                        layoutId={SNACK_CONTENT_LAYOUT_ID}
                        className={cn(
                            "bg-card border border-border rounded-3xl p-2 w-full transition-all duration-200",
                            onOpenUpgrade && "cursor-pointer hover:shadow-md"
                        )}
                        whileHover={onOpenUpgrade ? { scale: 1.02 } : undefined}
                        whileTap={onOpenUpgrade ? { scale: 0.98 } : undefined}
                        onClick={(e) => {
                            // Don't trigger if clicking on indicators or close button
                            const target = e.target as HTMLElement;
                            const isIndicatorClick = target.closest('[data-indicator-click]');
                            const isCloseClick = target.closest('[data-close-click]');

                            if (!isIndicatorClick && !isCloseClick && onOpenUpgrade) {
                                onOpenUpgrade();
                            }
                        }}
                    >
                        <UsagePreview
                            type={showUsagePreview}
                            subscriptionData={subscriptionData}
                            onClose={() => {
                                // First close the usage notification
                                if (onCloseUsage) onCloseUsage();

                                // Check what notifications will remain after closing usage
                                const willHaveToolNotification = showToolPreview && toolCalls.length > 0;
                                const willHaveUpgradeNotification = isFreeTier && !userDismissedUpgrade && onOpenUpgrade;

                                // If there will be other notifications, switch to them
                                if (willHaveToolNotification || willHaveUpgradeNotification) {
                                    const nextIndex = willHaveToolNotification ? 0 : notifications.indexOf('upgrade');
                                    if (nextIndex !== -1) {
                                        setCurrentView(nextIndex);
                                    }
                                }
                            }}
                            hasMultiple={hasMultiple}
                            showIndicators={hasMultiple}
                            currentIndex={currentView}
                            totalCount={totalNotifications}
                            onIndicatorClick={(index) => setCurrentView(index)}
                            onOpenUpgrade={onOpenUpgrade}
                        />
                    </motion.div>
                </motion.div>
            );
        }

        if (currentNotification === 'upgrade' && isFreeTier && subscriptionData && !isLocalMode() && onOpenUpgrade) {
            return (
                <motion.div
                    layoutId={SNACK_LAYOUT_ID}
                    layout
                    transition={{
                        layout: {
                            type: "spring",
                            stiffness: 300,
                            damping: 30
                        }
                    }}
                    className="-mb-4 w-full"
                    style={{ pointerEvents: 'auto' }}
                >
                    <motion.div
                        layoutId={SNACK_CONTENT_LAYOUT_ID}
                        className={cn(
                            "bg-card border border-border rounded-3xl p-2 w-full transition-all duration-200",
                            "cursor-pointer hover:shadow-md"
                        )}
                        whileHover={{ scale: 1.02 }}
                        whileTap={{ scale: 0.98 }}
                        onClick={(e) => {
                            // Don't trigger if clicking on indicators or close button
                            const target = e.target as HTMLElement;
                            const isIndicatorClick = target.closest('[data-indicator-click]');
                            const isCloseClick = target.closest('[data-close-click]');

                            if (!isIndicatorClick && !isCloseClick && onOpenUpgrade) {
                                onOpenUpgrade();
                            }
                        }}
                    >
                        <UpgradePreview
                            subscriptionData={subscriptionData}
                            onClose={() => {
                                // Mark upgrade as dismissed
                                setUserDismissedUpgrade(true);

                                // Check what notifications will remain after closing upgrade
                                const willHaveToolNotification = showToolPreview && toolCalls.length > 0;
                                const willHaveUsageNotification = showUsagePreview && subscriptionData;

                                // If there will be other notifications, switch to them
                                if (willHaveToolNotification || willHaveUsageNotification) {
                                    const nextIndex = willHaveToolNotification ? 0 : notifications.indexOf('usage');
                                    if (nextIndex !== -1) {
                                        setCurrentView(nextIndex);
                                    }
                                }
                            }}
                            hasMultiple={hasMultiple}
                            showIndicators={hasMultiple}
                            currentIndex={currentView}
                            totalCount={totalNotifications}
                            onIndicatorClick={(index) => setCurrentView(index)}
                            onOpenUpgrade={onOpenUpgrade}
                        />
                    </motion.div>
                </motion.div>
            );
        }

        return null;
    };

    return (
        <AnimatePresence mode="wait">
            {shouldShowSnack && (
                <motion.div
                    key={currentNotification}
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 8 }}
                    transition={{ duration: 0.3, ease: 'easeOut' }}
                >
                    {renderContent()}
                </motion.div>
            )}
        </AnimatePresence>
    );
};
