'use client';

import { useEffect, useState, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { ThreadIcon } from './thread-icon';
import { usePathname, useRouter } from 'next/navigation';
import { useSidebar } from '@/components/ui/sidebar';
import { ThreadWithProject, GroupedThreads } from '@/hooks/sidebar/use-sidebar';
import { processThreadsWithProjects, useProjects, useThreads, groupThreadsByDate } from '@/hooks/sidebar/use-sidebar';
import { cn } from '@/lib/utils';
import { SpotlightCard } from '@/components/ui/spotlight-card';
import { formatDateForList } from '@/lib/utils/date-formatting';

// Component for date group headers
const DateGroupHeader: React.FC<{ dateGroup: string; count: number }> = ({ dateGroup, count }) => {
    return (
        <div className="py-2 mt-4 first:mt-2">
            <div className="text-xs font-medium text-muted-foreground pl-2.5">
                {dateGroup}
            </div>
        </div>
    );
};

// Component for individual trigger run item
const TriggerRunItem: React.FC<{
    thread: ThreadWithProject;
    isActive: boolean;
    isThreadLoading: boolean;
    pathname: string | null;
    isMobile: boolean;
    handleThreadClick: (e: React.MouseEvent<HTMLAnchorElement>, threadId: string, url: string) => void;
}> = ({ thread, isActive, isThreadLoading, handleThreadClick, isMobile }) => {
    return (
        <SpotlightCard
            className={cn(
                "transition-colors cursor-pointer",
                isActive ? "bg-muted" : "bg-transparent"
            )}
        >
            <a
                href={thread.url}
                onClick={(e) => handleThreadClick(e, thread.threadId, thread.url)}
                className="block"
            >
                <div className="flex items-center gap-3 p-2.5 text-sm">
                    <div className="flex items-center justify-center w-10 h-10 rounded-2xl bg-card border-[1.5px] border-border flex-shrink-0">
                        {isThreadLoading ? (
                            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                        ) : (
                            <ThreadIcon
                                iconName={thread.iconName}
                                className="text-muted-foreground"
                                size={16}
                            />
                        )}
                    </div>
                    <span className="flex-1 truncate">{thread.projectName}</span>
                    <span className="text-xs text-muted-foreground flex-shrink-0">
                        {formatDateForList(thread.updatedAt)}
                    </span>
                </div>
            </a>
        </SpotlightCard>
    );
};

export function NavTriggerRuns() {
    const { isMobile, state, setOpenMobile } = useSidebar();
    const [loadingThreadId, setLoadingThreadId] = useState<string | null>(null);
    const pathname = usePathname();
    const router = useRouter();
    const isNavigatingRef = useRef(false);
    const queryClient = useQueryClient();

    const {
        data: projects = [],
        isLoading: isProjectsLoading,
        error: projectsError,
    } = useProjects();

    const {
        data: threads = [],
        isLoading: isThreadsLoading,
        error: threadsError,
    } = useThreads();

    const combinedThreads: ThreadWithProject[] =
        !isProjectsLoading && !isThreadsLoading ? processThreadsWithProjects(threads, projects) : [];

    // Filter only trigger threads (threads with projectName starting with "Trigger: ")
    const triggerThreads = combinedThreads.filter((thread) =>
        thread.projectName?.startsWith('Trigger: ')
    );

    const groupedTriggerThreads: GroupedThreads = groupThreadsByDate(triggerThreads);

    useEffect(() => {
        setLoadingThreadId(null);
    }, [pathname]);

    useEffect(() => {
        const handleNavigationComplete = () => {
            document.body.style.pointerEvents = 'auto';
            isNavigatingRef.current = false;
        };

        window.addEventListener('popstate', handleNavigationComplete);

        return () => {
            window.removeEventListener('popstate', handleNavigationComplete);
            document.body.style.pointerEvents = 'auto';
        };
    }, []);

    useEffect(() => {
        isNavigatingRef.current = false;
        document.body.style.pointerEvents = 'auto';
    }, [pathname]);

    // Function to handle thread click with loading state
    const handleThreadClick = (
        e: React.MouseEvent<HTMLAnchorElement>,
        threadId: string,
        url: string
    ) => {
        // Set loading state for normal clicks (not meta key)
        if (!e.metaKey) {
            setLoadingThreadId(threadId);
        }

        // Close mobile sidebar
        if (isMobile) {
            setOpenMobile(false);
        }
    };

    // Loading state or error handling
    const isLoading = isProjectsLoading || isThreadsLoading;
    const hasError = projectsError || threadsError;

    if (hasError) {
        console.error('Error loading trigger runs:', { projectsError, threadsError });
    }

    return (
        <div>
            {/* Section Header */}
            <div className="py-2 mt-4 first:mt-2">
                <div className="text-xs font-medium text-muted-foreground pl-2.5">
                    Trigger Runs
                </div>
            </div>

            <div className="overflow-y-auto max-h-[calc(100vh-480px)] [&::-webkit-scrollbar]:hidden [-ms-overflow-style:'none'] [scrollbar-width:'none'] pb-10">
                {(state !== 'collapsed' || isMobile) && (
                    <>
                        {isLoading ? (
                            // Show skeleton loaders while loading
                            <div className="space-y-1">
                                {Array.from({ length: 3 }).map((_, index) => (
                                    <div key={`skeleton-${index}`} className="flex items-center gap-3 px-2 py-2">
                                        <div className="h-10 w-10 bg-muted/10 border-[1.5px] border-border rounded-2xl animate-pulse"></div>
                                        <div className="h-4 bg-muted rounded flex-1 animate-pulse"></div>
                                        <div className="h-3 w-8 bg-muted rounded animate-pulse"></div>
                                    </div>
                                ))}
                            </div>
                        ) : triggerThreads.length > 0 ? (
                            // Show trigger runs grouped by date
                            <>
                                {Object.entries(groupedTriggerThreads).map(([dateGroup, threadsInGroup]) => (
                                    <div key={dateGroup}>
                                        <DateGroupHeader dateGroup={dateGroup} count={threadsInGroup.length} />
                                        {threadsInGroup.map((thread) => {
                                            const isActive = pathname?.includes(thread.threadId) || false;
                                            const isThreadLoading = loadingThreadId === thread.threadId;

                                            return (
                                                <TriggerRunItem
                                                    key={`trigger-run-${thread.threadId}`}
                                                    thread={thread}
                                                    isActive={isActive}
                                                    isThreadLoading={isThreadLoading}
                                                    pathname={pathname}
                                                    isMobile={isMobile}
                                                    handleThreadClick={handleThreadClick}
                                                />
                                            );
                                        })}
                                    </div>
                                ))}
                            </>
                        ) : (
                            <div className="py-2 text-sm text-muted-foreground pl-2">
                            </div>
                        )}
                    </>
                )}
            </div>
        </div>
    );
}
