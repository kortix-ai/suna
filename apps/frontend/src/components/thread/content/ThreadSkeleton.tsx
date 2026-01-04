import React from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

interface ThreadSkeletonProps {
    isSidePanelOpen?: boolean;
    showHeader?: boolean;
    messageCount?: number;
    compact?: boolean;
    initializingMessage?: string;
}

export function ThreadSkeleton({
    isSidePanelOpen = false,
    showHeader = true,
    messageCount = 3,
    compact = false,
    initializingMessage,
}: ThreadSkeletonProps) {
    // Compact mode for embedded use
    if (compact) {
        return (
            <div className="h-full flex flex-col">
                {/* Compact thread content */}
                <div className="flex-1 overflow-y-auto p-4">
                    <div className="space-y-8">
                        {/* Generate message skeletons */}
                        {Array.from({ length: messageCount }).map((_, index) => (
                            <React.Fragment key={index}>
                                {/* User message */}
                                {index % 2 === 0 ? (
                                    <div className="space-y-3">
                                        <div className="flex justify-end">
                                            <div className="flex max-w-[85%] rounded-3xl rounded-br-lg bg-card border px-4 py-3">
                                                <div className="space-y-2 min-w-0 flex-1">
                                                    <Skeleton className="h-4 w-48" />
                                                    <Skeleton className="h-4 w-32" />
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                ) : (
                                    /* Assistant response */
                                    <div className="space-y-3">
                                        <div className="flex flex-col gap-2">
                                            {/* Agent Avatar & Name */}
                                            <div className="flex items-center gap-2">
                                                <Skeleton className="h-6 w-6 rounded-md flex-shrink-0" />
                                                <Skeleton className="h-4 w-16" />
                                            </div>
                                            
                                             {/* Assistant Message Content */}
                                             <div className="flex max-w-[90%]">
                                                 <div className="space-y-3 min-w-0 flex-1">
                                                     <div className="space-y-2">
                                                         <Skeleton className="h-4 w-full" />
                                                         <Skeleton className="h-4 w-[90%]" />
                                                         <Skeleton className="h-4 w-[75%]" />
                                                     </div>
                                                     
                                                     {/* Tool call section */}
                                                     {index % 3 === 1 && (
                                                         <div className="space-y-2 mt-3">
                                                             <Skeleton className="h-10 w-full rounded-2xl" />
                                                             <div className="space-y-2">
                                                                 <Skeleton className="h-4 w-full" />
                                                                 <Skeleton className="h-4 w-[85%]" />
                                                                 <Skeleton className="h-4 w-[70%]" />
                                                             </div>
                                                         </div>
                                                     )}
                                                     
                                                     {/* Additional longer response lines */}
                                                     <div className="space-y-2 mt-3">
                                                         <Skeleton className="h-4 w-full" />
                                                         <Skeleton className="h-4 w-[95%]" />
                                                         <Skeleton className="h-4 w-[88%]" />
                                                         <Skeleton className="h-4 w-[92%]" />
                                                         <Skeleton className="h-4 w-[78%]" />
                                                     </div>
                                                 </div>
                                             </div>
                                        </div>
                                    </div>
                                )}
                            </React.Fragment>
                        ))}

                        {/* Assistant thinking state */}
                        <div className="space-y-3">
                            <div className="flex flex-col gap-2">
                                <div className="flex items-center gap-2">
                                    <Skeleton className="h-6 w-6 rounded-md flex-shrink-0" />
                                    <Skeleton className="h-4 w-16" />
                                </div>
                                <div className="flex items-center gap-1.5 py-1">
                                    <div className="h-1.5 w-1.5 rounded-full bg-muted-foreground/30 animate-pulse" />
                                    <div className="h-1.5 w-1.5 rounded-full bg-muted-foreground/30 animate-pulse delay-150" style={{ animationDelay: '150ms' }} />
                                    <div className="h-1.5 w-1.5 rounded-full bg-muted-foreground/30 animate-pulse delay-300" style={{ animationDelay: '300ms' }} />
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

            </div>
        );
    }

    // Full layout mode
    return (
        <div className="flex h-screen">
            <div
                className="flex flex-col flex-1 overflow-hidden transition-all duration-200 ease-in-out sm:mr-[50vw]"
            >
                {/* Skeleton Header */}
                {showHeader && (
                    <div className="bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
                        <div className="flex h-14 items-center gap-4 px-4">
                            {initializingMessage && (
                                <div className="flex-1">
                                    <div className="flex items-center gap-2 text-muted-foreground">
                                        <div className="h-2 w-2 rounded-full bg-blue-500 animate-pulse" />
                                        <span className="text-sm">{initializingMessage}</span>
                                    </div>
                                </div>
                            )}
                            {!initializingMessage && (
                            <div className="flex-1">
                                <div className="flex items-center gap-2">
                                    <Skeleton className="h-5 w-5 rounded" />
                                    <Skeleton className="h-5 w-40" />
                                </div>
                            </div>
                            )}
                            {!initializingMessage && (
                            <div className="flex items-center gap-2">
                                <Skeleton className="h-9 w-9 rounded-md" />
                                <Skeleton className="h-9 w-9 rounded-md" />
                            </div>
                            )}
                        </div>
                    </div>
                )}

                {/* Skeleton Chat Messages */}
                <div className="flex-1 overflow-y-auto py-4 pb-4 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
                    <div className="mx-auto max-w-3xl px-4 md:px-6">
                        <div className="space-y-8">
                            {/* Generate multiple message skeletons based on messageCount */}
                            {Array.from({ length: messageCount }).map((_, index) => (
                                <React.Fragment key={index}>
                                    {/* User message - every other message */}
                                    {index % 2 === 0 ? (
                                        <div className="space-y-3">
                                            <div className="flex justify-end">
                                                <div className="flex max-w-[85%] rounded-3xl rounded-br-lg bg-card border px-4 py-3">
                                                    <div className="space-y-2 min-w-0 flex-1">
                                                        <Skeleton className="h-4 w-64" />
                                                        <Skeleton className="h-4 w-48" />
                                                    </div>
                                                </div>
                                            </div>
                                        </div>
                                    ) : (
                                        /* Assistant response with tool usage */
                                        <div className="space-y-3">
                                            <div className="flex flex-col gap-2">
                                                {/* Agent Avatar & Name */}
                                                <div className="flex items-center gap-2">
                                                    <Skeleton className="h-6 w-6 rounded-md flex-shrink-0" />
                                                    <Skeleton className="h-4 w-16" />
                                                </div>
                                                
                                             {/* Assistant Message Content */}
                                             <div className="flex max-w-[90%]">
                                                 <div className="space-y-3 min-w-0 flex-1">
                                                     <div className="space-y-2">
                                                         <Skeleton className="h-4 w-full max-w-[400px]" />
                                                         <Skeleton className="h-4 w-full max-w-[360px]" />
                                                         <Skeleton className="h-4 w-full max-w-[300px]" />
                                                     </div>

                                                         {/* Tool call section */}
                                                         {index % 3 === 1 && (
                                                             <div className="space-y-2 mt-3">
                                                                 <Skeleton className="h-10 w-full max-w-[400px] rounded-2xl" />
                                                                 <div className="space-y-2">
                                                                     <Skeleton className="h-4 w-full max-w-[380px]" />
                                                                     <Skeleton className="h-4 w-full max-w-[340px]" />
                                                                     <Skeleton className="h-4 w-full max-w-[280px]" />
                                                                 </div>
                                                             </div>
                                                         )}
                                                         
                                                         {/* Additional longer response lines */}
                                                         <div className="space-y-2 mt-3">
                                                             <Skeleton className="h-4 w-full max-w-[420px]" />
                                                             <Skeleton className="h-4 w-full max-w-[390px]" />
                                                             <Skeleton className="h-4 w-full max-w-[410px]" />
                                                             <Skeleton className="h-4 w-full max-w-[370px]" />
                                                             <Skeleton className="h-4 w-full max-w-[320px]" />
                                                         </div>
                                                     </div>
                                                 </div>
                                            </div>
                                        </div>
                                    )}
                                </React.Fragment>
                            ))}

                            {/* Assistant thinking state */}
                            <div className="space-y-3">
                                <div className="flex flex-col gap-2">
                                    <div className="flex items-center gap-2">
                                        <Skeleton className="h-6 w-6 rounded-md flex-shrink-0" />
                                        <Skeleton className="h-4 w-16" />
                                    </div>
                                    <div className="flex items-center gap-1.5 py-1">
                                        <div className="h-1.5 w-1.5 rounded-full bg-muted-foreground/30 animate-pulse" />
                                        <div className="h-1.5 w-1.5 rounded-full bg-muted-foreground/30 animate-pulse delay-150" style={{ animationDelay: '150ms' }} />
                                        <div className="h-1.5 w-1.5 rounded-full bg-muted-foreground/30 animate-pulse delay-300" style={{ animationDelay: '300ms' }} />
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

            </div>

            {/* Side Panel - Elegant floating skeleton matching actual design */}
            <div className="hidden sm:block fixed top-2 right-2 bottom-4 w-[calc(50vw-1rem)] pointer-events-none z-30">
                <div className="h-full border rounded-3xl bg-card pointer-events-auto flex flex-col overflow-hidden">
                    {/* Header */}
                    <div className="pt-4 pl-4 pr-4">
                        <div className="flex items-center justify-between">
                            <div className="ml-2">
                                <Skeleton className="h-5 w-32" />
                            </div>
                            <Skeleton className="h-8 w-8 rounded-md" />
                        </div>
                    </div>

                    {/* Content area */}
                    <div className="flex-1 overflow-hidden p-6 pt-4">
                        <div className="space-y-3">
                            {/* Tool sections */}
                            <div className="space-y-2">
                                <Skeleton className="h-4 w-24" />
                                <div className="rounded-lg border bg-muted/30 p-4 space-y-2">
                                    <Skeleton className="h-3 w-full" />
                                    <Skeleton className="h-3 w-3/4" />
                                </div>
                            </div>

                            <div className="space-y-2">
                                <Skeleton className="h-4 w-32" />
                                <div className="rounded-lg border bg-muted/30 p-4 space-y-2">
                                    <Skeleton className="h-3 w-full" />
                                    <Skeleton className="h-3 w-5/6" />
                                    <Skeleton className="h-3 w-2/3" />
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Footer navigation */}
                    <div className="border-t bg-muted/20 px-4 py-2.5">
                        <div className="flex items-center gap-3">
                            <div className="flex items-center gap-1">
                                <Skeleton className="h-7 w-7 rounded-md" />
                                <Skeleton className="h-4 w-12" />
                                <Skeleton className="h-7 w-7 rounded-md" />
                            </div>
                            <Skeleton className="h-2 flex-1 rounded-full" />
                            <Skeleton className="h-6 w-24 rounded-full" />
                        </div>
                    </div>
                </div>
            </div>

        </div>
    );
}