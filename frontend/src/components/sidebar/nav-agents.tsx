'use client';

import { useEffect, useState, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  ArrowUpRight,
  Link as LinkIcon,
  MoreHorizontal,
  Trash2,
  MessagesSquare,
  Loader2,
  ExternalLink,
  X,
  History,
  ChevronRight,
  Zap,
  Folder
} from "lucide-react"
import { ThreadIcon } from "./thread-icon"
import { toast } from "sonner"
import { usePathname, useRouter } from "next/navigation"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { SpotlightCard } from '@/components/ui/spotlight-card';
import { cn } from '@/lib/utils';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@/components/ui/sidebar';
import Link from "next/link"
import { ShareModal } from "./share-modal"
import { DeleteConfirmationDialog } from "@/components/thread/DeleteConfirmationDialog"
import { useDeleteOperation } from '@/stores/delete-operation-store'
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { ThreadWithProject, GroupedThreads } from '@/hooks/sidebar/use-sidebar';
import { processThreadsWithProjects, useDeleteMultipleThreads, useDeleteThread, useProjects, groupThreadsByDate } from '@/hooks/sidebar/use-sidebar';
import { projectKeys, threadKeys } from '@/hooks/threads/keys';
import { useThreadAgentStatuses } from '@/hooks/threads';
import { formatDateForList } from '@/lib/utils/date-formatting';
import { Thread, getThreadsPaginated } from '@/lib/api/threads';
import { useQuery } from '@tanstack/react-query';

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

// Component for individual thread item
const ThreadItem: React.FC<{
  thread: ThreadWithProject;
  isActive: boolean;
  isThreadLoading: boolean;
  isSelected: boolean;
  selectedThreads: Set<string>;
  loadingThreadId: string | null;
  pathname: string | null;
  isMobile: boolean;
  isAgentRunning?: boolean;
  isMultiSelectMode?: boolean;
  handleThreadClick: (e: React.MouseEvent<HTMLAnchorElement>, threadId: string, url: string) => void;
  toggleThreadSelection: (threadId: string, e?: React.MouseEvent) => void;
  handleDeleteThread: (threadId: string, threadName: string) => void;
  setSelectedItem: (item: { threadId: string; projectId: string } | null) => void;
  setShowShareModal: (show: boolean) => void;
}> = ({
  thread,
  isActive,
  isThreadLoading,
  isSelected,
  isAgentRunning,
  isMultiSelectMode,
  handleThreadClick,
  toggleThreadSelection,
  handleDeleteThread,
  setSelectedItem,
  setShowShareModal,
  isMobile
}) => {
    const [isHoveringIcon, setIsHoveringIcon] = useState(false);
    const [isHoveringCard, setIsHoveringCard] = useState(false);

    return (
      <SpotlightCard
        className={cn(
          "transition-colors cursor-pointer",
          isActive ? "bg-muted" : "bg-transparent"
        )}
      >
        <Link
          href={thread.url}
          onClick={(e) => handleThreadClick(e, thread.threadId, thread.url)}
          prefetch={false}
          className="block"
        >
          <div
            className="flex items-center gap-3 p-2.5 text-sm"
            onMouseEnter={() => setIsHoveringCard(true)}
            onMouseLeave={() => setIsHoveringCard(false)}
          >
            <div
              className="relative flex items-center justify-center w-10 h-10 rounded-2xl bg-card border-[1.5px] border-border flex-shrink-0 group/icon"
              onMouseEnter={() => setIsHoveringIcon(true)}
              onMouseLeave={() => setIsHoveringIcon(false)}
            >
              {isThreadLoading ? (
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              ) : (
                <>
                  <ThreadIcon
                    iconName={thread.iconName}
                    className={cn(
                      "text-muted-foreground transition-opacity",
                      (isHoveringIcon || isMultiSelectMode) ? "opacity-0" : "opacity-100"
                    )}
                    size={14}
                  />
                  <div
                    className={cn(
                      "absolute inset-0 flex items-center justify-center transition-opacity",
                      (isHoveringIcon || isMultiSelectMode) ? "opacity-100" : "opacity-0"
                    )}
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      toggleThreadSelection(thread.threadId);
                    }}
                  >
                    <Checkbox
                      checked={isSelected}
                      className="h-4 w-4"
                    />
                  </div>
                </>
              )}
              {isAgentRunning && (
                <div className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 bg-green-500 rounded-full border border-background animate-pulse" />
              )}
            </div>
            <span className="flex-1 truncate">{thread.projectName}</span>
            <div className="flex-shrink-0 relative">
              <span
                className={cn(
                  "text-xs text-muted-foreground transition-opacity",
                  isHoveringCard ? "opacity-0" : "opacity-100"
                )}
              >
                {formatDateForList(thread.updatedAt)}
              </span>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    className={cn(
                      "absolute top-1/2 right-0 -translate-y-1/2 p-1 rounded-md hover:bg-accent transition-all text-muted-foreground",
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
                      setSelectedItem({ threadId: thread.threadId, projectId: thread.projectId });
                      setShowShareModal(true);
                    }}
                  >
                    <LinkIcon className="mr-2 h-4 w-4" />
                    Share
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      window.open(thread.url, '_blank');
                    }}
                  >
                    <ExternalLink className="mr-2 h-4 w-4" />
                    Open in new tab
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      handleDeleteThread(thread.threadId, thread.projectName);
                    }}
                  >
                    <Trash2 className="mr-2 h-4 w-4" />
                    Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        </Link>
      </SpotlightCard>
    );
  };

export function NavAgents() {
  const { isMobile, state, setOpenMobile } = useSidebar()
  const [loadingThreadId, setLoadingThreadId] = useState<string | null>(null)
  const [showShareModal, setShowShareModal] = useState(false)
  const [selectedItem, setSelectedItem] = useState<{ threadId: string, projectId: string } | null>(null)
  const pathname = usePathname()
  const router = useRouter()
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false)
  const [threadToDelete, setThreadToDelete] = useState<{ id: string; name: string } | null>(null)
  const isNavigatingRef = useRef(false)
  const { performDelete } = useDeleteOperation();
  const isPerformingActionRef = useRef(false);
  const queryClient = useQueryClient();

  const [selectedThreads, setSelectedThreads] = useState<Set<string>>(new Set());
  const [deleteProgress, setDeleteProgress] = useState(0);
  const [totalToDelete, setTotalToDelete] = useState(0);
  const [isMultiSelectMode, setIsMultiSelectMode] = useState(false);

  // Pagination state
  const [currentPage, setCurrentPage] = useState(1);
  const [allThreads, setAllThreads] = useState<Thread[]>([]);
  const pageLimit = 50;
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const savedScrollPositionRef = useRef<number | null>(null);

  const {
    data: projects = [],
    isLoading: isProjectsLoading,
    error: projectsError
  } = useProjects();

  // Use paginated threads API directly
  const {
    data: threadsResponse,
    isLoading: isThreadsLoading,
    error: threadsError
  } = useQuery({
    queryKey: [...threadKeys.lists(), 'paginated', currentPage, pageLimit],
    queryFn: () => getThreadsPaginated(undefined, currentPage, pageLimit),
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const { mutate: deleteThreadMutation, isPending: isDeletingSingle } = useDeleteThread();
  const {
    mutate: deleteMultipleThreadsMutation,
    isPending: isDeletingMultiple
  } = useDeleteMultipleThreads();

  // Accumulate threads as we load more pages
  useEffect(() => {
    if (threadsResponse?.threads) {
      if (currentPage === 1) {
        // Reset threads on first page
        setAllThreads(threadsResponse.threads);
      } else {
        // Append new threads for subsequent pages
        setAllThreads(prev => {
          const existingIds = new Set(prev.map(t => t.thread_id));
          const newThreads = threadsResponse.threads.filter(t => !existingIds.has(t.thread_id));
          return [...prev, ...newThreads];
        });
      }
    }
  }, [threadsResponse, currentPage]);

  // Reset pagination when total thread count changes (e.g., after deletion)
  const previousTotalRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (threadsResponse?.pagination) {
      const currentTotal = threadsResponse.pagination.total;

      // If the total decreased (threads were deleted), reset to page 1
      if (previousTotalRef.current !== undefined &&
        currentTotal < previousTotalRef.current &&
        currentPage > 1) {
        setCurrentPage(1);
        setAllThreads([]);
      }

      previousTotalRef.current = currentTotal;
    }
  }, [threadsResponse?.pagination, currentPage]);

  // Always process threads if we have them, even while loading more
  const combinedThreads: ThreadWithProject[] =
    !isProjectsLoading && allThreads.length > 0 && projects.length > 0 ?
      processThreadsWithProjects(allThreads, projects) : [];

  // Separate trigger threads from regular threads
  const regularThreads = combinedThreads.filter(thread => !thread.projectName?.startsWith('Trigger: '));
  const triggerThreads = combinedThreads.filter(thread => thread.projectName?.startsWith('Trigger: '));

  const groupedThreads: GroupedThreads = groupThreadsByDate(regularThreads);
  const groupedTriggerThreads: GroupedThreads = groupThreadsByDate(triggerThreads);

  // Check if there are more threads to load
  const hasMore = threadsResponse?.pagination &&
    threadsResponse.pagination.page < threadsResponse.pagination.pages;

  const handleLoadMore = () => {
    if (hasMore && !isThreadsLoading) {
      // Save current scroll position and height before loading more
      const scrollContainer = scrollContainerRef.current;
      if (scrollContainer) {
        savedScrollPositionRef.current = scrollContainer.scrollTop;
      }

      setCurrentPage(prev => prev + 1);
    }
  };

  // Restore scroll position after new threads are loaded
  useEffect(() => {
    if (savedScrollPositionRef.current !== null && !isThreadsLoading && allThreads.length > 0) {
      const scrollContainer = scrollContainerRef.current;
      if (scrollContainer) {
        // Use requestAnimationFrame for smoother scroll restoration
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            if (scrollContainer && savedScrollPositionRef.current !== null) {
              scrollContainer.scrollTop = savedScrollPositionRef.current;
              savedScrollPositionRef.current = null;
            }
          });
        });
      }
    }
  }, [isThreadsLoading, allThreads.length]);

  // Track agent running status for all threads
  const threadIds = combinedThreads.map(thread => thread.threadId);
  const agentStatusMap = useThreadAgentStatuses(threadIds);

  const handleDeletionProgress = (completed: number, total: number) => {
    const percentage = (completed / total) * 100;
    setDeleteProgress(percentage);
  };

  useEffect(() => {
    const handleProjectUpdate = (event: Event) => {
      const customEvent = event as CustomEvent;
      if (customEvent.detail) {
        const { projectId, updatedData } = customEvent.detail;
        queryClient.invalidateQueries({ queryKey: projectKeys.details(projectId) });
        queryClient.invalidateQueries({ queryKey: projectKeys.lists() });
      }
    };

    window.addEventListener('project-updated', handleProjectUpdate as EventListener);
    return () => {
      window.removeEventListener(
        'project-updated',
        handleProjectUpdate as EventListener,
      );
    };
  }, [queryClient]);

  useEffect(() => {
    setLoadingThreadId(null);
  }, [pathname]);

  useEffect(() => {
    const handleNavigationComplete = () => {
      document.body.style.pointerEvents = 'auto';
      isNavigatingRef.current = false;
    };

    window.addEventListener("popstate", handleNavigationComplete);

    return () => {
      window.removeEventListener('popstate', handleNavigationComplete);
      // Ensure we clean up any leftover styles
      document.body.style.pointerEvents = "auto";
    };
  }, []);

  // Reset isNavigatingRef when pathname changes
  useEffect(() => {
    isNavigatingRef.current = false;
    document.body.style.pointerEvents = 'auto';
  }, [pathname]);

  // Function to handle thread click with loading state
  const handleThreadClick = (e: React.MouseEvent<HTMLAnchorElement>, threadId: string, url: string) => {
    // If thread is selected, prevent navigation 
    if (selectedThreads.has(threadId)) {
      e.preventDefault();
      return;
    }

    // Set loading state for normal clicks (not meta key)
    if (!e.metaKey) {
      setLoadingThreadId(threadId);
    }

    // Close mobile menu on navigation
    if (isMobile) {
      setOpenMobile(false);
    }
  }

  // Toggle thread selection for multi-select
  const toggleThreadSelection = (threadId: string, e?: React.MouseEvent) => {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }

    setSelectedThreads(prev => {
      const newSelection = new Set(prev);
      if (newSelection.has(threadId)) {
        newSelection.delete(threadId);
      } else {
        newSelection.add(threadId);
      }

      // Enter multi-select mode when first item is selected
      if (newSelection.size > 0) {
        setIsMultiSelectMode(true);
      } else {
        setIsMultiSelectMode(false);
      }

      return newSelection;
    });
  };

  // Select all threads
  const selectAllThreads = () => {
    const allThreadIds = combinedThreads.map(thread => thread.threadId);
    setSelectedThreads(new Set(allThreadIds));
    setIsMultiSelectMode(true);
  };

  // Deselect all threads
  const deselectAllThreads = () => {
    setSelectedThreads(new Set());
    setIsMultiSelectMode(false);
  };

  // Exit multi-select mode
  const exitMultiSelectMode = () => {
    setSelectedThreads(new Set());
    setIsMultiSelectMode(false);
  };

  // Function to handle thread deletion
  const handleDeleteThread = async (threadId: string, threadName: string) => {
    setThreadToDelete({ id: threadId, name: threadName });
    setIsDeleteDialogOpen(true);
  };

  // Function to handle multi-delete
  const handleMultiDelete = () => {
    if (selectedThreads.size === 0) return;

    // Get thread names for confirmation dialog
    const threadsToDelete = combinedThreads.filter(t => selectedThreads.has(t.threadId));
    const threadNames = threadsToDelete.map(t => t.projectName).join(", ");

    setThreadToDelete({
      id: "multiple",
      name: selectedThreads.size > 3
        ? `${selectedThreads.size} conversations`
        : threadNames
    });

    setTotalToDelete(selectedThreads.size);
    setDeleteProgress(0);
    setIsDeleteDialogOpen(true);
  };

  const confirmDelete = async () => {
    if (!threadToDelete || isPerformingActionRef.current) return;

    // Mark action in progress
    isPerformingActionRef.current = true;

    // Close dialog first for immediate feedback
    setIsDeleteDialogOpen(false);

    // Check if it's a single thread or multiple threads
    if (threadToDelete.id !== "multiple") {
      // Single thread deletion
      const threadId = threadToDelete.id;
      const isActive = pathname?.includes(threadId);

      // Store threadToDelete in a local variable since it might be cleared
      const deletedThread = { ...threadToDelete };

      // Get sandbox ID from projects data
      const thread = combinedThreads.find(t => t.threadId === threadId);
      const project = projects.find(p => p.id === thread?.projectId);
      const sandboxId = project?.sandbox?.id;

      // Use the centralized deletion system with completion callback
      await performDelete(
        threadId,
        isActive,
        async () => {
          // Delete the thread using the mutation with sandbox ID
          deleteThreadMutation(
            { threadId, sandboxId },
            {
              onSuccess: () => {
                // Invalidate queries to refresh the list
                queryClient.invalidateQueries({ queryKey: threadKeys.lists() });
                toast.success('Conversation deleted successfully');
              },
              onSettled: () => {
                setThreadToDelete(null);
                isPerformingActionRef.current = false;
              }
            }
          );
        },
        // Completion callback to reset local state
        () => {
          setThreadToDelete(null);
          isPerformingActionRef.current = false;
        },
      );
    } else {
      // Multi-thread deletion
      const threadIdsToDelete = Array.from(selectedThreads);
      const isActiveThreadIncluded = threadIdsToDelete.some(id => pathname?.includes(id));

      // Show initial toast
      toast.info(`Deleting ${threadIdsToDelete.length} conversations...`);

      try {
        // If the active thread is included, handle navigation first
        if (isActiveThreadIncluded) {
          // Navigate to dashboard before deleting
          isNavigatingRef.current = true;
          document.body.style.pointerEvents = 'none';
          router.push('/dashboard');

          // Wait a moment for navigation to start
          await new Promise(resolve => setTimeout(resolve, 100));
        }

        // Use the mutation for bulk deletion
        deleteMultipleThreadsMutation(
          {
            threadIds: threadIdsToDelete,
            threadSandboxMap: Object.fromEntries(
              threadIdsToDelete.map(threadId => {
                const thread = combinedThreads.find(t => t.threadId === threadId);
                const project = projects.find(p => p.id === thread?.projectId);
                return [threadId, project?.sandbox?.id || ''];
              }).filter(([, sandboxId]) => sandboxId)
            ),
            onProgress: handleDeletionProgress
          },
          {
            onSuccess: (data) => {
              // Invalidate queries to refresh the list
              queryClient.invalidateQueries({ queryKey: threadKeys.lists() });

              // Show success message
              toast.success(`Successfully deleted ${data.successful.length} conversations`);

              // If some deletions failed, show warning
              if (data.failed.length > 0) {
                toast.warning(`Failed to delete ${data.failed.length} conversations`);
              }

              // Reset states
              setSelectedThreads(new Set());
              setDeleteProgress(0);
              setTotalToDelete(0);
            },
            onError: (error) => {
              console.error('Error in bulk deletion:', error);
              toast.error('Error deleting conversations');
            },
            onSettled: () => {
              setThreadToDelete(null);
              isPerformingActionRef.current = false;
              setDeleteProgress(0);
              setTotalToDelete(0);
            }
          }
        );
      } catch (err) {
        console.error('Error initiating bulk deletion:', err);
        toast.error('Error initiating deletion process');

        // Reset states
        setSelectedThreads(new Set());
        setThreadToDelete(null);
        isPerformingActionRef.current = false;
        setDeleteProgress(0);
        setTotalToDelete(0);
      }
    }
  };

  // Loading state or error handling
  // Only show skeleton on initial load, not when loading more pages
  const isInitialLoading = (isProjectsLoading || isThreadsLoading) && combinedThreads.length === 0;
  const isLoading = isInitialLoading;
  const hasError = projectsError || threadsError;

  if (hasError) {
    console.error('Error loading data:', { projectsError, threadsError });
  }

  return (
    <div>
      {/* Search hint or Multi-select header */}
      {(state !== 'collapsed' || isMobile) && (
        <>
          {isMultiSelectMode ? (
            <div className="px-2.5 pt-5 mb-1 flex items-center justify-between gap-2">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 px-3 text-xs"
                    onClick={selectedThreads.size === combinedThreads.length ? deselectAllThreads : selectAllThreads}
                  >
                    {selectedThreads.size === combinedThreads.length ? 'Deselect All' : 'Select All'}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  {selectedThreads.size === combinedThreads.length ? 'Deselect all conversations' : 'Select all conversations'}
                </TooltipContent>
              </Tooltip>

              {selectedThreads.size > 0 && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 relative"
                      onClick={handleMultiDelete}
                    >
                      <Trash2 className="h-4 w-4" />
                      <span className="absolute bottom-1 right-1 h-3 w-3 rounded-full bg-primary text-primary-foreground text-[8px] font-medium flex items-center justify-center">
                        {selectedThreads.size}
                      </span>
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Delete {selectedThreads.size} conversation{selectedThreads.size > 1 ? 's' : ''}</TooltipContent>
                </Tooltip>
              )}
            </div>
          ) : (
            <div className="px-2.5 pt-5 mb-1 flex items-center justify-between text-xs text-muted-foreground">
              <span>Search</span>
              <div className="flex items-center gap-1 h-8">
                <kbd className="h-6 w-6 flex items-center justify-center bg-muted border border-border rounded-md text-base leading-0 cursor-pointer">⌘</kbd>
                <kbd className="h-6 w-6 flex items-center justify-center bg-muted border border-border rounded-md text-xs cursor-pointer">K</kbd>
              </div>
            </div>
          )}
        </>
      )}

      <div ref={scrollContainerRef} className="overflow-y-auto max-h-[calc(100vh-280px)] [&::-webkit-scrollbar]:hidden [-ms-overflow-style:'none'] [scrollbar-width:'none'] pb-16">
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
            ) : combinedThreads.length > 0 ? (
              // Show threads grouped by date
              <>
                {Object.entries(groupedThreads).map(([dateGroup, threadsInGroup]) => (
                  <div key={dateGroup}>
                    <DateGroupHeader dateGroup={dateGroup} count={threadsInGroup.length} />
                    {threadsInGroup.map((thread) => {
                      const isActive = pathname?.includes(thread.threadId) || false;
                      const isThreadLoading = loadingThreadId === thread.threadId;
                      const isSelected = selectedThreads.has(thread.threadId);
                      const isAgentRunning = agentStatusMap.get(thread.threadId) || false;

                      return (
                        <ThreadItem
                          key={`thread-${thread.threadId}`}
                          thread={thread}
                          isActive={isActive}
                          isThreadLoading={isThreadLoading}
                          isSelected={isSelected}
                          selectedThreads={selectedThreads}
                          loadingThreadId={loadingThreadId}
                          pathname={pathname}
                          isMobile={isMobile}
                          isAgentRunning={isAgentRunning}
                          isMultiSelectMode={isMultiSelectMode}
                          handleThreadClick={handleThreadClick}
                          toggleThreadSelection={toggleThreadSelection}
                          handleDeleteThread={handleDeleteThread}
                          setSelectedItem={setSelectedItem}
                          setShowShareModal={setShowShareModal}
                        />
                      );
                    })}
                  </div>
                ))}

                {/* Show skeleton loaders while loading more threads */}
                {isThreadsLoading && allThreads.length > 0 && (
                  <div className="space-y-1 mt-1">
                    {Array.from({ length: 3 }).map((_, index) => (
                      <div key={`loading-skeleton-${index}`} className="flex items-center gap-3 px-2 py-2">
                        <div className="h-10 w-10 bg-muted/10 border-[1.5px] border-border rounded-2xl animate-pulse"></div>
                        <div className="h-4 bg-muted rounded flex-1 animate-pulse"></div>
                        <div className="h-3 w-8 bg-muted rounded animate-pulse"></div>
                      </div>
                    ))}
                  </div>
                )}

                {/* Load More section - simple and minimal */}
                {threadsResponse?.pagination && threadsResponse.pagination.total > pageLimit && !isThreadsLoading && (
                  <div className="px-2 py-3">
                    {hasMore ? (
                      <button
                        onClick={handleLoadMore}
                        className={cn(
                          "w-full py-2 px-3 text-xs text-muted-foreground",
                          "hover:text-foreground hover:bg-accent/50",
                          "transition-colors rounded-md",
                          "flex items-center justify-center gap-2"
                        )}
                      >
                        <span>Load more ({threadsResponse.pagination.total - allThreads.length} remaining)</span>
                      </button>
                    ) : (
                      <div className="text-center py-2 text-xs text-muted-foreground">
                        All threads loaded
                      </div>
                    )}
                  </div>
                )}
              </>
            ) : (
              <div className="py-2 pl-2.5 text-sm text-muted-foreground">
                No conversations yet
              </div>
            )}
          </>
        )}
      </div>

      {(isDeletingSingle || isDeletingMultiple) && totalToDelete > 0 && (
        <div className="mt-2 px-2">
          <div className="text-xs text-muted-foreground mb-1">
            Deleting {deleteProgress > 0 ? `(${Math.floor(deleteProgress)}%)` : '...'}
          </div>
          <div className="w-full bg-secondary h-1 rounded-full overflow-hidden">
            <div
              className="bg-primary h-1 transition-all duration-300 ease-in-out"
              style={{ width: `${deleteProgress}%` }}
            />
          </div>
        </div>
      )}

      <ShareModal
        isOpen={showShareModal}
        onClose={() => setShowShareModal(false)}
        threadId={selectedItem?.threadId}
        projectId={selectedItem?.projectId}
      />

      {threadToDelete && (
        <DeleteConfirmationDialog
          isOpen={isDeleteDialogOpen}
          onClose={() => setIsDeleteDialogOpen(false)}
          onConfirm={confirmDelete}
          threadName={threadToDelete.name}
          isDeleting={isDeletingSingle || isDeletingMultiple}
        />
      )}
    </div>
  );
}