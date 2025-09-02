import React from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { ChatInput } from '@/components/thread/chat-input/chat-input';
import { cn } from '@/lib/utils';

interface ThreadSkeletonProps {
    isSidePanelOpen?: boolean;
    showHeader?: boolean;
    messageCount?: number;
    compact?: boolean;
}

export function ThreadSkeleton({
    isSidePanelOpen = false,
    showHeader = true,
    messageCount = 3,
    compact = false,
}: ThreadSkeletonProps) {
    // Compact mode for embedded use
    if (compact) {
        return (
            <div className="h-full flex flex-col">
                {/* Compact thread content */}
                <div className="flex-1 overflow-y-auto p-4">
                    <div className="space-y-4">
                        {/* Generate message skeletons */}
                        {Array.from({ length: messageCount }).map((_, index) => (
                            <React.Fragment key={index}>
                                {/* User message */}
                                {index % 2 === 0 ? (
                                    <div className="flex justify-end">
                                        <div className="max-w-[80%] rounded-lg bg-primary/10 px-3 py-2">
                                            <div className="space-y-1">
                                                <Skeleton className="h-3 w-32" />
                                                <Skeleton className="h-3 w-24" />
                                            </div>
                                        </div>
                                    </div>
                                ) : (
                                    /* Assistant response */
                                    <div className="flex items-start gap-2">
                                        <Skeleton className="flex-shrink-0 w-4 h-4 mt-1 rounded-full" />
                                        <div className="flex-1 max-w-[80%]">
                                            <div className="rounded-lg bg-muted px-3 py-2">
                                                <div className="space-y-2">
                                                    <div className="space-y-1">
                                                        <Skeleton className="h-3 w-full" />
                                                        <Skeleton className="h-3 w-3/4" />
                                                        <Skeleton className="h-3 w-1/2" />
                                                    </div>
                                                    
                                                    {/* Tool call button skeleton */}
                                                    {index % 3 === 1 && (
                                                        <Skeleton className="h-5 w-20 rounded-md" />
                                                    )}
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                )}
                            </React.Fragment>
                        ))}

                        {/* Assistant thinking state */}
                        <div className="flex items-start gap-2">
                            <Skeleton className="flex-shrink-0 w-4 h-4 mt-1 rounded-full" />
                            <div className="flex items-center gap-1 py-1">
                                <div className="h-1 w-1 rounded-full bg-gray-400/50 animate-pulse" />
                                <div className="h-1 w-1 rounded-full bg-gray-400/50 animate-pulse delay-150" />
                                <div className="h-1 w-1 rounded-full bg-gray-400/50 animate-pulse delay-300" />
                            </div>
                        </div>
                    </div>
                </div>

                {/* Compact Chat Input */}
                <div className="flex-shrink-0 border-t border-border/20 bg-background p-4">
                    <ChatInput
                        onSubmit={() => {}}
                        onChange={() => {}}
                        placeholder="Describe what you need help with..."
                        loading={false}
                        disabled={true}
                        isAgentRunning={false}
                        value=""
                        hideAttachments={false}
                        isLoggedIn={true}
                        hideAgentSelection={true}
                        defaultShowSnackbar={false}
                        enableAdvancedConfig={true}
                    />
                </div>
            </div>
        );
    }

    // Full layout mode
    return (
        <div className="flex h-screen">
            <div
                className={`flex flex-col flex-1 overflow-hidden transition-all duration-200 ease-in-out`}
            >
                {/* Skeleton Header */}
                {showHeader && (
                    <div className="border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
                        <div className="flex h-14 items-center gap-4 px-4">
                            <div className="flex-1">
                                <div className="flex items-center gap-2">
                                    <Skeleton className="h-6 w-6 rounded-full" />
                                    <Skeleton className="h-5 w-40" />
                                </div>
                            </div>
                            <div className="flex items-center gap-2">
                                <Skeleton className="h-8 w-8 rounded-full" />
                                <Skeleton className="h-8 w-8 rounded-full" />
                            </div>
                        </div>
                    </div>
                )}

                {/* Skeleton Chat Messages */}
                <div className="flex-1 overflow-y-auto px-6 py-4 pb-72">
                    <div className="mx-auto max-w-3xl space-y-6">
                        {/* Generate multiple message skeletons based on messageCount */}
                        {Array.from({ length: messageCount }).map((_, index) => (
                            <React.Fragment key={index}>
                                {/* User message - every other message */}
                                {index % 2 === 0 ? (
                                    <div className="flex justify-end">
                                        <div className="max-w-[85%] rounded-lg bg-primary/10 px-4 py-3">
                                            <div className="space-y-2">
                                                <Skeleton className="h-4 w-48" />
                                                <Skeleton className="h-4 w-32" />
                                            </div>
                                        </div>
                                    </div>
                                ) : (
                                    /* Assistant response with tool usage */
                                    <div>
                                        <div className="flex items-start gap-3">
                                            <Skeleton className="flex-shrink-0 w-5 h-5 mt-2 rounded-full" />
                                            <div className="flex-1 space-y-2">
                                                <div className="max-w-[90%] w-full rounded-lg bg-muted px-4 py-3">
                                                    <div className="space-y-3">
                                                        <div>
                                                            <Skeleton className="h-4 w-full max-w-[360px] mb-2" />
                                                            <Skeleton className="h-4 w-full max-w-[320px] mb-2" />
                                                            <Skeleton className="h-4 w-full max-w-[290px]" />
                                                        </div>

                                                        {/* Tool call button skeleton */}
                                                        {index % 3 === 1 && (
                                                            <div className="py-1">
                                                                <Skeleton className="h-6 w-32 rounded-md" />
                                                            </div>
                                                        )}

                                                        {index % 3 === 1 && (
                                                            <div>
                                                                <Skeleton className="h-4 w-full max-w-[340px] mb-2" />
                                                                <Skeleton className="h-4 w-full max-w-[280px]" />
                                                            </div>
                                                        )}
                                                    </div>
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                )}
                            </React.Fragment>
                        ))}

                        {/* Assistant thinking state */}
                        <div>
                            <div className="flex items-start gap-3">
                                <Skeleton className="flex-shrink-0 w-5 h-5 mt-2 rounded-full" />
                                <div className="flex-1 space-y-2">
                                    <div className="flex items-center gap-1.5 py-1">
                                        <div className="h-1.5 w-1.5 rounded-full bg-gray-400/50 animate-pulse" />
                                        <div className="h-1.5 w-1.5 rounded-full bg-gray-400/50 animate-pulse delay-150" />
                                        <div className="h-1.5 w-1.5 rounded-full bg-gray-400/50 animate-pulse delay-300" />
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                {/* ChatInput - Inside the left div, positioned at bottom with exact same styling */}
                <div
                    className={cn(
                        "bg-gradient-to-t from-background via-background/90 to-transparent px-0 pt-8 transition-all duration-200 ease-in-out"
                    )}
                >
                    <div className={cn(
                        "mx-auto",
                        "max-w-3xl"
                    )}>
                        <ChatInput
                            onSubmit={() => {}}
                            onChange={() => {}}
                            placeholder="Describe what you need help with..."
                            loading={false}
                            disabled={true}
                            isAgentRunning={false}
                            value=""
                            hideAttachments={false}
                            isLoggedIn={true}
                            hideAgentSelection={true}
                            defaultShowSnackbar={false}
                            enableAdvancedConfig={true}
                        />
                    </div>
                </div>
            </div>

            {/* Side Panel - Always visible in skeleton with exact responsive widths */}
            <div className="hidden sm:block">
                <div className="h-screen w-[90%] sm:w-[450px] md:w-[500px] lg:w-[550px] xl:w-[650px] border-l">
                    <div className="p-4">
                        <Skeleton className="h-8 w-32 mb-4" />
                        <Skeleton className="h-20 w-full rounded-md mb-4" />
                        <Skeleton className="h-40 w-full rounded-md" />
                    </div>
                </div>
            </div>
        </div>
    );
}