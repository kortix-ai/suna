'use client';

import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { cn } from '@/lib/utils';
import { UpgradePreview } from './upgrade-preview';
import { FloatingToolPreview, ToolCallInput } from './floating-tool-preview';
import { isLocalMode } from '@/lib/config';

export interface ChatSnackProps {
    toolCalls?: ToolCallInput[];
    toolCallIndex?: number;
    onExpandToolPreview?: () => void;
    agentName?: string;
    showToolPreview?: boolean;
    subscriptionData?: any;
    onOpenUpgrade?: () => void;
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
    subscriptionData,
    onOpenUpgrade,
    isVisible = false,
}) => {
    const [currentView, setCurrentView] = React.useState(0);
    const [userDismissedUpgrade, setUserDismissedUpgrade] = React.useState(false);

    const isFreeTier = subscriptionData && (
        subscriptionData.tier_key === 'free' ||
        subscriptionData.tier?.name === 'free' ||
        subscriptionData.plan_name === 'free'
    );

    const notifications = [];

    if (showToolPreview && toolCalls.length > 0) {
        notifications.push('tool');
    }

    if (isFreeTier && subscriptionData && !isLocalMode() && !userDismissedUpgrade && onOpenUpgrade) {
        notifications.push('upgrade');
    }

    const totalNotifications = notifications.length;
    const hasMultiple = totalNotifications > 1;

    React.useEffect(() => {
        if (currentView >= totalNotifications && totalNotifications > 0) {
            setCurrentView(0);
        }
    }, [totalNotifications, currentView]);

    const shouldShowSnack = isVisible || 
        (isFreeTier && subscriptionData && !isLocalMode() && !userDismissedUpgrade && onOpenUpgrade && totalNotifications > 0);
    
    React.useEffect(() => {
        if (!hasMultiple || !shouldShowSnack) return;

        const interval = setInterval(() => {
            setCurrentView((prev) => (prev + 1) % totalNotifications);
        }, 20000);

        return () => clearInterval(interval);
    }, [hasMultiple, shouldShowSnack, totalNotifications, currentView]);
    
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
                                setUserDismissedUpgrade(true);
                                const willHaveToolNotification = showToolPreview && toolCalls.length > 0;
                                if (willHaveToolNotification) {
                                    setCurrentView(0);
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
        <div>
            {shouldShowSnack && renderContent()}
        </div>
    );
};
