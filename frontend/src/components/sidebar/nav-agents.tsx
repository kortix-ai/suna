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
  ChevronLeft,
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
import { Thread, getThreadsPaginated, type ThreadsResponse } from '@/lib/api/threads';
import { useThreads } from '@/hooks/threads/use-threads';
import { useTranslations } from 'next-intl';
import { useMemo } from 'react';
import { Project } from '@/lib/api/projects';

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
  const t = useTranslations('sidebar');
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
  const pageLimit = 50;
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const {
    data: projects = [],
    isLoading: isProjectsLoading,
    error: projectsError
  } = useProjects();

  // Use unified paginated threads hook - returns full ThreadsResponse with pagination
  const {
    data: threadsResponse,
    isLoading: isThreadsLoading,
    error: threadsError
  } = useThreads({
    page: currentPage,
    limit: pageLimit,
  });
  
  console.log('📋 NavAgents: useThreads response', { 
    threadsCount: threadsResponse?.threads?.length || 0,
    pagination: threadsResponse?.pagination,
    isThreadsLoading,
    currentPage 
  });

  const { mutate: deleteThreadMutation, isPending: isDeletingSingle } = useDeleteThread();
  const {
    mutate: deleteMultipleThreadsMutation,
    isPending: isDeletingMultiple
  } = useDeleteMultipleThreads();

  // Use threads directly from response
  const currentThreads = threadsResponse?.threads || [];
  
  console.log('📋 NavAgents: Current threads', {
    currentThreadsLength: currentThreads.length,
    currentPage,
    hasProjectData: !!currentThreads[0]?.project
  });

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
      }

      previousTotalRef.current = currentTotal;
    }
  }, [threadsResponse?.pagination, currentPage]);

  // Process threads directly - backend already provides project data!
  // No need to map threads to projects, just transform the data structure
  const combinedThreads: ThreadWithProject[] = useMemo(() => {
    if (currentThreads.length === 0) {
      console.log('📦 NavAgents: No threads to process');
      return [];
    }
    
    const processed: ThreadWithProject[] = [];
    
    for (const thread of currentThreads) {
      const projectId = thread.project_id;
      const project = thread.project; // Backend already provides this!
      
      if (!projectId || !project) {
        console.log('📦 NavAgents: Thread missing project data', {
          thread_id: thread.thread_id,
          project_id: projectId,
          hasProject: !!project
        });
        continue;
      }
      
      const displayName = project.name || 'Unnamed Project';
      const iconName = project.icon_name;
      
      processed.push({
        threadId: thread.thread_id,
        projectId: projectId,
        projectName: displayName,
        url: `/projects/${projectId}/thread/${thread.thread_id}`,
        updatedAt: thread.updated_at || project.updated_at || new Date().toISOString(),
        iconName: iconName,
      });
    }
    
    console.log('📦 NavAgents: Processed threads', {
      inputCount: currentThreads.length,
      outputCount: processed.length,
      sample: processed[0]
    });
    
    // Sort by updated_at
    return processed.sort((a, b) => 
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );
  }, [currentThreads]);

  // Separate trigger threads from regular threads
  const regularThreads = combinedThreads.filter(thread => !thread.projectName?.startsWith('Trigger: '));
  const triggerThreads = combinedThreads.filter(thread => thread.projectName?.startsWith('Trigger: '));

  const groupedThreads: GroupedThreads = groupThreadsByDate(regularThreads);
  const groupedTriggerThreads: GroupedThreads = groupThreadsByDate(triggerThreads);
  
  // Debug logging for grouped threads
  console.log('📋 NavAgents: Grouped threads', {
    combinedCount: combinedThreads.length,
    regularCount: regularThreads.length,
    triggerCount: triggerThreads.length,
    groupedKeys: Object.keys(groupedThreads),
    groupedCounts: Object.entries(groupedThreads).map(([key, threads]) => ({ [key]: threads.length }))
  });

  // Pagination helpers
  const pagination = threadsResponse?.pagination;
  const totalPages = pagination?.pages || 1;
  const canGoPrevious = currentPage > 1;
  const canGoNext = currentPage < totalPages;
  
  console.log('📋 NavAgents: Pagination state', {
    threadsResponseExists: !!threadsResponse,
    paginationExists: !!pagination,
    pagination,
    totalPages,
    currentPage,
    canGoPrevious,
    canGoNext
  });

  const handlePreviousPage = () => {
    if (canGoPrevious) {
      setCurrentPage(prev => prev - 1);
      scrollContainerRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };

  const handleNextPage = () => {
    if (canGoNext) {
      setCurrentPage(prev => prev + 1);
      scrollContainerRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };


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

      // Get sandbox ID from thread's project data (backend already provides this)
      const thread = combinedThreads.find(t => t.threadId === threadId);
      const currentThread = currentThreads.find(t => t.thread_id === threadId);
      const sandboxId = currentThread?.project?.sandbox?.id;

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
                const currentThread = currentThreads.find(t => t.thread_id === threadId);
                const sandboxId = currentThread?.project?.sandbox?.id || '';
                return [threadId, sandboxId];
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

                {/* Minimal pagination controls */}
                {pagination && totalPages > 1 && (
                  <div className="px-2 py-2">
                    <div className="flex items-center justify-center gap-3">
                      <button
                        onClick={handlePreviousPage}
                        disabled={!canGoPrevious || isThreadsLoading}
                        className={cn(
                          "p-1.5 text-xs transition-opacity",
                          canGoPrevious && !isThreadsLoading
                            ? "text-muted-foreground hover:text-foreground opacity-70 hover:opacity-100"
                            : "text-muted-foreground/30 cursor-not-allowed"
                        )}
                      >
                        <ChevronLeft className="h-3.5 w-3.5" />
                      </button>
                      
                      <span className="text-xs text-muted-foreground/70">
                        {currentPage}/{totalPages}
                      </span>
                      
                      <button
                        onClick={handleNextPage}
                        disabled={!canGoNext || isThreadsLoading}
                        className={cn(
                          "p-1.5 text-xs transition-opacity",
                          canGoNext && !isThreadsLoading
                            ? "text-muted-foreground hover:text-foreground opacity-70 hover:opacity-100"
                            : "text-muted-foreground/30 cursor-not-allowed"
                        )}
                      >
                        <ChevronRight className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                )}
              </>
            ) : (
              <div className="py-2 pl-2.5 text-sm text-muted-foreground">
                {t('noConversations')}
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