'use client';

import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { cn } from '@/lib/utils';
import { UpgradePreview } from './upgrade-preview';
import { FloatingToolPreview, ToolCallInput } from './floating-tool-preview';
import { isLocalMode } from '@/lib/config';
import { Volume2, Play, Pause, RotateCcw, X, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useVoicePlayerStore } from '@/stores/voice-player-store';

export interface ChatSnackProps {
    toolCalls?: ToolCallInput[];
    toolCallIndex?: number;
    onExpandToolPreview?: () => void;
    agentName?: string;
    showToolPreview?: boolean;
    subscriptionData?: any;
    onOpenUpgrade?: () => void;
    isVisible?: boolean;
    threadId?: string | null;  // Only show voice player when in a thread
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
    threadId,
}) => {
    const [currentView, setCurrentView] = React.useState(0);
    const [userDismissedUpgrade, setUserDismissedUpgrade] = React.useState(false);

    // Voice player state
    const {
        state: voiceState,
        text: voiceText,
        togglePlayPause,
        close: voiceClose,
    } = useVoicePlayerStore();

    const isVoiceActive = voiceState !== 'idle';
    const isVoiceLoading = voiceState === 'loading';
    const isVoicePlaying = voiceState === 'playing';
    const isVoicePaused = voiceState === 'paused';
    const isVoiceEnded = voiceState === 'ended';
    const isVoiceError = voiceState === 'error';

    const isFreeTier = subscriptionData && (
        subscriptionData.tier_key === 'free' ||
        subscriptionData.tier?.name === 'free' ||
        subscriptionData.plan_name === 'free'
    );

    const notifications: string[] = [];

    // Voice takes priority when active (only show in thread context)
    if (isVoiceActive && threadId) {
        notifications.push('voice');
    }

    if (showToolPreview && toolCalls.length > 0) {
        notifications.push('tool');
    }

    if (isFreeTier && subscriptionData && !isLocalMode() && !userDismissedUpgrade && onOpenUpgrade) {
        notifications.push('upgrade');
    }

    const totalNotifications = notifications.length;
    const hasMultiple = totalNotifications > 1;

    // When voice becomes active, switch to voice view
    React.useEffect(() => {
        if (isVoiceActive && notifications[0] === 'voice') {
            setCurrentView(0);
        }
    }, [isVoiceActive, notifications]);

    React.useEffect(() => {
        if (currentView >= totalNotifications && totalNotifications > 0) {
            setCurrentView(0);
        }
    }, [totalNotifications, currentView]);

    const shouldShowSnack = isVisible || (isVoiceActive && threadId) ||
        (isFreeTier && subscriptionData && !isLocalMode() && !userDismissedUpgrade && onOpenUpgrade && totalNotifications > 0);

    React.useEffect(() => {
        if (!hasMultiple || !shouldShowSnack) return;
        // Don't auto-cycle when voice is active
        if (isVoiceActive) return;

        const interval = setInterval(() => {
            setCurrentView((prev) => (prev + 1) % totalNotifications);
        }, 20000);

        return () => clearInterval(interval);
    }, [hasMultiple, shouldShowSnack, totalNotifications, currentView, isVoiceActive]);
    
    if (!shouldShowSnack || totalNotifications === 0) return null;

    const currentNotification = notifications[currentView];

    const renderContent = () => {
        // Voice player snack - matches FloatingToolPreview structure
        if (currentNotification === 'voice' && isVoiceActive) {
            const voiceDisplayText = voiceText && voiceText.length > 50
                ? voiceText.slice(0, 50) + '...'
                : voiceText;

            const statusText = isVoiceLoading
                ? 'Generating...'
                : isVoiceError
                    ? 'Failed'
                    : isVoicePlaying
                        ? 'Playing'
                        : isVoiceEnded
                            ? 'Finished'
                            : 'Paused';

            const statusColor = isVoiceLoading
                ? 'bg-blue-500/10'
                : isVoiceError
                    ? 'bg-red-500/10'
                    : 'bg-green-500/10';

            const dotColor = isVoiceLoading
                ? 'bg-blue-500'
                : isVoiceError
                    ? 'bg-red-500'
                    : 'bg-green-500';

            const textColor = isVoiceLoading
                ? 'text-blue-500'
                : isVoiceError
                    ? 'text-red-500'
                    : 'text-green-500';

            return (
                <motion.div
                    className="-mb-4 w-full"
                    style={{ pointerEvents: 'auto' }}
                    initial={{ opacity: 0, y: 20, scale: 0.95 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: 8, scale: 0.98 }}
                    transition={{ type: "spring", stiffness: 400, damping: 30 }}
                >
                    <motion.div
                        className="bg-card border border-border rounded-3xl p-2 w-full"
                        whileHover={{ scale: 1.01 }}
                        whileTap={{ scale: 0.99 }}
                        transition={{ type: "spring", stiffness: 400, damping: 30 }}
                    >
                        <div className="flex items-center gap-3">
                            {/* Voice Icon */}
                            <div className="flex-shrink-0">
                                <div className="w-10 h-10 rounded-2xl flex items-center justify-center bg-gradient-to-br from-zinc-500/20 to-zinc-600/10 border border-zinc-500/20">
                                    {isVoiceLoading ? (
                                        <Loader2 className="h-5 w-5 animate-spin text-zinc-500 dark:text-zinc-400" />
                                    ) : (
                                        <Volume2 className="h-5 w-5 text-zinc-500 dark:text-zinc-400" />
                                    )}
                                </div>
                            </div>

                            {/* Text Preview */}
                            <div className="flex-1 min-w-0 flex items-center justify-between gap-3">
                                <div className="flex-1 min-w-0">
                                    <h4 className="text-sm font-medium text-foreground truncate">
                                        {voiceDisplayText || 'Voice'}
                                    </h4>
                                </div>

                                {/* Status Badge */}
                                <div className={cn('flex-shrink-0 inline-flex items-center gap-1.5 px-2 py-1 rounded-full', statusColor)}>
                                    <div className={cn('w-1.5 h-1.5 rounded-full', dotColor, isVoiceLoading && 'animate-pulse')} />
                                    <span className={cn('text-xs font-medium whitespace-nowrap', textColor)}>{statusText}</span>
                                </div>
                            </div>

                            {/* Indicators */}
                            {hasMultiple && (
                                <button
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        const nextIndex = currentView === 0 ? 1 : 0;
                                        setCurrentView(nextIndex);
                                    }}
                                    className="flex items-center gap-1.5 mr-3 px-2 py-1.5 rounded-lg hover:bg-muted/30 transition-colors"
                                >
                                    {notifications.map((_, index) => (
                                        <div
                                            key={index}
                                            className={cn(
                                                'transition-all duration-300 ease-out rounded-full',
                                                index === currentView
                                                    ? 'w-6 h-2 bg-foreground'
                                                    : 'w-3 h-2 bg-muted-foreground/40'
                                            )}
                                        />
                                    ))}
                                </button>
                            )}

                            {/* Play/Pause/Replay Button */}
                            {(isVoicePlaying || isVoicePaused || isVoiceEnded) && (
                                <Button
                                    variant="default"
                                    size="icon"
                                    className="h-8 w-8 rounded-full shrink-0"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        togglePlayPause();
                                    }}
                                >
                                    {isVoiceEnded ? (
                                        <RotateCcw className="h-3.5 w-3.5" />
                                    ) : isVoicePlaying ? (
                                        <Pause className="h-3.5 w-3.5" />
                                    ) : (
                                        <Play className="h-3.5 w-3.5 ml-0.5" />
                                    )}
                                </Button>
                            )}

                            {/* Close Button */}
                            <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8 rounded-full shrink-0 text-muted-foreground hover:text-foreground"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    voiceClose();
                                }}
                            >
                                <X className="h-4 w-4" />
                            </Button>
                        </div>
                    </motion.div>
                </motion.div>
            );
        }

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
