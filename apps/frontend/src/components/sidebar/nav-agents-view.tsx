'use client';

import { useState, useMemo, useCallback, startTransition } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { MoreHorizontal, Trash2, ExternalLink, Frown } from 'lucide-react';
import { useSidebar } from '@/components/ui/sidebar';
import { cn } from '@/lib/utils';
import { SpotlightCard } from '@/components/ui/spotlight-card';
import { formatDateForList } from '@/lib/utils/date-formatting';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { DeleteConfirmationDialog } from "@/components/thread/DeleteConfirmationDialog";
import { toast } from "@/lib/toast";
import { useQueryClient } from '@tanstack/react-query';
import { ThreadIcon } from "./thread-icon";
import { useThreads } from '@/hooks/threads/use-threads';
import { useThreadAgentStatuses } from '@/hooks/threads';
import { useDeleteThread } from '@/hooks/sidebar/use-sidebar';
import { threadKeys } from '@/hooks/threads/keys';

// Component for section headers
const SectionHeader: React.FC<{ title: string; count: number }> = ({ title, count }) => {
    return (
        <div className="py-2 mt-4 first:mt-2">
            <div className="text-xs font-medium text-muted-foreground pl-2.5 flex items-center gap-2">
                {title}
                <span className="text-muted-foreground/60">({count})</span>
            </div>
        </div>
    );
};

// Component for a thread item showing its current activity
const ThreadActivityItem: React.FC<{
    thread: any;
    isActive: boolean;
    isAgentRunning: boolean;
    onNavigate: (thread: any) => void;
    handleDeleteThread: (threadId: string, threadName: string) => void;
}> = ({ thread, isActive, isAgentRunning, onNavigate, handleDeleteThread }) => {
    const [isHoveringCard, setIsHoveringCard] = useState(false);

    const projectName = thread.project?.name || 'Unnamed Project';
    const iconName = thread.project?.icon_name;
    const libraryUrl = `/library/${thread.project_id}`;
    const threadUrl = `/projects/${thread.project_id}/thread/${thread.thread_id}`;
    const updatedAt = thread.updated_at || new Date().toISOString();

    const handleClick = (e: React.MouseEvent) => {
        e.preventDefault();
        
        // Cmd/Ctrl+click opens thread in new tab
        if (e.metaKey || e.ctrlKey) {
            window.open(threadUrl, '_blank');
            return;
        }
        
        // Regular click navigates to library file browser
        onNavigate(thread);
    };

    return (
        <SpotlightCard
            className={cn(
                "transition-colors cursor-pointer",
                isActive ? "bg-muted" : "bg-transparent"
            )}
        >
            <div
                onClick={handleClick}
                className="block"
            >
                <div
                    className="flex items-center gap-3 p-2.5 text-sm"
                    onMouseEnter={() => setIsHoveringCard(true)}
                    onMouseLeave={() => setIsHoveringCard(false)}
                >
                    {/* Icon */}
                    <div className="relative flex items-center justify-center w-10 h-10 rounded-2xl bg-card border-[1.5px] border-border flex-shrink-0">
                        <ThreadIcon
                            iconName={iconName}
                            className="text-muted-foreground"
                            size={14}
                        />
                        {isAgentRunning && (
                            <div className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 bg-green-500 rounded-full border border-background animate-pulse" />
                        )}
                    </div>
                    
                    {/* Name */}
                    <span className="flex-1 truncate">{projectName}</span>

                    {/* Date & Menu */}
                    <div className="flex-shrink-0 relative">
                        <span
                            className={cn(
                                "text-xs text-muted-foreground transition-opacity",
                                isHoveringCard ? "opacity-0" : "opacity-100"
                            )}
                        >
                            {formatDateForList(updatedAt)}
                        </span>
                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <button
                                    className={cn(
                                        "absolute top-1/2 right-0 -translate-y-1/2 p-1 rounded-2xl hover:bg-accent transition-all text-muted-foreground",
                                        isHoveringCard ? "opacity-100" : "opacity-0 pointer-events-none"
                                    )}
                                    onClick={(e) => {
                                        e.preventDefault();
                                        e.stopPropagation();
                                    }}
                                >
                                    <MoreHorizontal className="h-4 w-4 rotate-90" />
                                </button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="w-48">
                                <DropdownMenuItem
                                    onClick={(e) => {
                                        e.preventDefault();
                                        e.stopPropagation();
                                        window.open(threadUrl, '_blank');
                                    }}
                                >
                                    <ExternalLink className="mr-2 h-4 w-4" />
                                    Open chat
                                </DropdownMenuItem>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                    onClick={(e) => {
                                        e.preventDefault();
                                        e.stopPropagation();
                                        handleDeleteThread(thread.thread_id, projectName);
                                    }}
                                >
                                    <Trash2 className="mr-2 h-4 w-4" />
                                    Delete
                                </DropdownMenuItem>
                            </DropdownMenuContent>
                        </DropdownMenu>
                    </div>
                </div>
            </div>
        </SpotlightCard>
    );
};

export function NavAgentsView() {
    const { isMobile, state, setOpenMobile } = useSidebar();
    const router = useRouter();
    const pathname = usePathname();
    const queryClient = useQueryClient();

    const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
    const [threadToDelete, setThreadToDelete] = useState<{ id: string; name: string } | null>(null);

    // Fetch threads
    const {
        data: threadsResponse,
        isLoading: isThreadsLoading,
    } = useThreads({
        page: 1,
        limit: 50,
    });

    const { mutate: deleteThreadMutation, isPending: isDeleting } = useDeleteThread();

    const threads = threadsResponse?.threads || [];

    // Get agent status for all threads
    const threadIds = threads.map(t => t.thread_id);
    const agentStatusMap = useThreadAgentStatuses(threadIds);

    // Separate threads into running and recent
    const { runningThreads, recentThreads } = useMemo(() => {
        const running: typeof threads = [];
        const recent: typeof threads = [];

        threads.forEach(thread => {
            const isRunning = agentStatusMap.get(thread.thread_id) || false;
            if (isRunning) {
                running.push(thread);
            } else {
                recent.push(thread);
            }
        });

        // Sort both by updated_at
        running.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
        recent.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());

        return { runningThreads: running, recentThreads: recent };
    }, [threads, agentStatusMap]);

    const handleNavigateToLibrary = useCallback((thread: any) => {
        if (isMobile) {
            setOpenMobile(false);
        }
        // Use startTransition for non-blocking navigation
        startTransition(() => {
            router.push(`/library/${thread.project_id}`);
        });
    }, [router, isMobile, setOpenMobile]);

    const handleDeleteThread = (threadId: string, threadName: string) => {
        setThreadToDelete({ id: threadId, name: threadName });
        setIsDeleteDialogOpen(true);
    };

    const confirmDelete = async () => {
        if (!threadToDelete) return;

        setIsDeleteDialogOpen(false);
        const threadId = threadToDelete.id;
        const isActive = pathname?.includes(threadId);

        // Get sandbox ID if available
        const thread = threads.find(t => t.thread_id === threadId);
        const sandboxId = thread?.project?.sandbox?.id;

        deleteThreadMutation(
            { threadId, sandboxId },
            {
                onSuccess: () => {
                    queryClient.invalidateQueries({ queryKey: threadKeys.lists() });
                    toast.success('Conversation deleted successfully');

                    if (isActive) {
                        router.push('/dashboard');
                    }
                },
                onSettled: () => {
                    setThreadToDelete(null);
                }
            }
        );
    };

    const hasRunning = runningThreads.length > 0;
    const hasRecent = recentThreads.length > 0;

    return (
        <div className="w-full">
            <div className="overflow-y-auto max-h-[calc(100vh-280px)] [&::-webkit-scrollbar]:hidden [-ms-overflow-style:'none'] [scrollbar-width:'none'] pb-32">
                {(state !== 'collapsed' || isMobile) && (
                    <>
                        {isThreadsLoading ? (
                            // Show skeleton loaders while loading
                            <div className="space-y-1">
                                <SectionHeader title="Activity" count={0} />
                                {Array.from({ length: 3 }).map((_, index) => (
                                    <div key={`skeleton-${index}`} className="flex items-center gap-3 px-2 py-2">
                                        <div className="h-10 w-10 bg-muted/10 border-[1.5px] border-border rounded-2xl animate-pulse"></div>
                                        <div className="h-4 bg-muted rounded flex-1 animate-pulse"></div>
                                        <div className="h-3 w-8 bg-muted rounded animate-pulse"></div>
                                    </div>
                                ))}
                            </div>
                        ) : threads.length > 0 ? (
                            <>
                                {/* Running threads section */}
                                {hasRunning && (
                                    <>
                                        <SectionHeader title="Running" count={runningThreads.length} />
                                        {runningThreads.map((thread) => {
                                            const isActive = pathname?.includes(`/library/${thread.project_id}`) || false;
                                            return (
                                                <ThreadActivityItem
                                                    key={thread.thread_id}
                                                    thread={thread}
                                                    isActive={isActive}
                                                    isAgentRunning={true}
                                                    onNavigate={handleNavigateToLibrary}
                                                    handleDeleteThread={handleDeleteThread}
                                                />
                                            );
                                        })}
                                    </>
                                )}

                                {/* Recent threads section */}
                                {hasRecent && (
                                    <>
                                        <SectionHeader title="Recent" count={recentThreads.length} />
                                        {recentThreads.slice(0, 20).map((thread) => {
                                            const isActive = pathname?.includes(`/library/${thread.project_id}`) || false;
                                            const isAgentRunning = agentStatusMap.get(thread.thread_id) || false;
                                            return (
                                                <ThreadActivityItem
                                                    key={thread.thread_id}
                                                    thread={thread}
                                                    isActive={isActive}
                                                    isAgentRunning={isAgentRunning}
                                                    onNavigate={handleNavigateToLibrary}
                                                    handleDeleteThread={handleDeleteThread}
                                                />
                                            );
                                        })}
                                    </>
                                )}
                            </>
                        ) : (
                            <div className="flex flex-col items-center justify-center py-12 px-6 text-center">
                                <div className="flex items-center justify-center w-14 h-14 rounded-2xl bg-muted/30 border border-border mb-4">
                                    <Frown className="h-6 w-6 text-muted-foreground/50" />
                                </div>
                                <p className="text-sm font-medium text-muted-foreground mb-1">
                                    No activity yet
                                </p>
                                <p className="text-xs text-muted-foreground/60">
                                    Start a new chat to see activity here
                                </p>
                            </div>
                        )}
                    </>
                )}
            </div>

            {threadToDelete && (
                <DeleteConfirmationDialog
                    isOpen={isDeleteDialogOpen}
                    onClose={() => setIsDeleteDialogOpen(false)}
                    onConfirm={confirmDelete}
                    threadName={threadToDelete.name}
                    isDeleting={isDeleting}
                />
            )}
        </div>
    );
}
