'use client';

import { useEffect, useState, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  MoreHorizontal,
  Trash2,
  Loader2,
  ChevronRight,
  ChevronLeft,
  Frown,
  Plus,
  ChevronDown
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
import { useSidebar } from '@/components/ui/sidebar';
import Link from "next/link"
import { DeleteConfirmationDialog } from "@/components/thread/DeleteConfirmationDialog"
import { useDeleteOperation } from '@/stores/delete-operation-store'
import { Button } from "@/components/ui/button"
import { ThreadWithProject, GroupedByProject, ProjectGroup, GroupedByDateThenProject } from '@/hooks/sidebar/use-sidebar';
import { useDeleteMultipleThreads, useDeleteThread, useProjects, groupThreadsByDateThenProject } from '@/hooks/sidebar/use-sidebar';
import { projectKeys, threadKeys } from '@/hooks/threads/keys';
import { useThreadAgentStatuses } from '@/hooks/threads';
import { formatDateForList } from '@/lib/utils/date-formatting';
import { createThreadInProject } from '@/lib/api/threads';
import { useThreads } from '@/hooks/threads/use-threads';
import { useTranslations } from 'next-intl';
import { useMemo } from 'react';

// Date group header component
const DateGroupHeader: React.FC<{ dateGroup: string }> = ({ dateGroup }) => {
  return (
    <div className="py-2 mt-4 first:mt-2">
      <div className="text-xs font-medium text-muted-foreground px-2.5">
        {dateGroup}
      </div>
    </div>
  );
};

// Single chat card - matches original ThreadItem design exactly
const SingleChatCard: React.FC<{
  thread: ThreadWithProject;
  projectGroup: ProjectGroup;
  isActive: boolean;
  isThreadLoading: boolean;
  isAgentRunning: boolean;
  handleThreadClick: (e: React.MouseEvent<HTMLAnchorElement>, threadId: string, url: string) => void;
  handleDeleteThread: (threadId: string, threadName: string) => void;
  handleCreateNewChat: (projectId: string) => Promise<void>;
  isCreatingChat: boolean;
}> = ({
  thread,
  projectGroup,
  isActive,
  isThreadLoading,
  isAgentRunning,
  handleThreadClick,
  handleDeleteThread,
  handleCreateNewChat,
  isCreatingChat,
}) => {
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
          {/* Icon */}
          <div className="relative flex items-center justify-center w-10 h-10 rounded-2xl bg-card border-[1.5px] border-border flex-shrink-0">
            {isThreadLoading ? (
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            ) : (
              <ThreadIcon
                iconName={projectGroup.iconName}
                className="text-muted-foreground"
                size={14}
              />
            )}
            {isAgentRunning && (
              <div className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 bg-green-500 rounded-full border border-background animate-pulse" />
            )}
          </div>
          
          {/* Name */}
          <span className="flex-1 truncate">{projectGroup.projectName}</span>
          
          {/* Date & Menu */}
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
                    handleCreateNewChat(projectGroup.projectId);
                  }}
                  disabled={isCreatingChat}
                >
                  {isCreatingChat ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Plus className="mr-2 h-4 w-4" />
                  )}
                  New chat
                </DropdownMenuItem>
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
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set());
  const [isCreatingChat, setIsCreatingChat] = useState(false);

  // Pagination state
  const [currentPage, setCurrentPage] = useState(1);
  const pageLimit = 20; // Reduced from 50 to 20 to reduce API response size
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
    isFetching: isThreadsFetching,
    error: threadsError
  } = useThreads({
    page: currentPage,
    limit: pageLimit,
  });

  const { mutate: deleteThreadMutation, isPending: isDeletingSingle } = useDeleteThread();
  const {
    mutate: deleteMultipleThreadsMutation,
    isPending: isDeletingMultiple
  } = useDeleteMultipleThreads();

  // Use threads directly from response
  const currentThreads = threadsResponse?.threads || [];

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
      return [];
    }
    
    const processed: ThreadWithProject[] = [];
    
    for (const thread of currentThreads) {
      const projectId = thread.project_id;
      const project = thread.project; // Backend already provides this!
      
      // Handle threads without project data gracefully
      // This can happen if the project was deleted or thread created without project
      if (!projectId) {
        // Thread has no project_id - skip these orphan threads
        console.debug('Thread without project_id:', thread.thread_id);
        continue;
      }
      
      // Use fallback values if project data is missing (e.g., deleted project)
      const displayName = project?.name || 'Unnamed Project';
      const iconName = project?.icon_name;
      const updatedAt = thread.updated_at || project?.updated_at || new Date().toISOString();
      const formattedDate = formatDateForList(updatedAt);
      
      processed.push({
        threadId: thread.thread_id,
        projectId: projectId,
        projectName: displayName,
        threadName: thread.name && thread.name.trim() ? thread.name : formattedDate,
        url: `/projects/${projectId}/thread/${thread.thread_id}`,
        updatedAt: updatedAt,
        iconName: iconName,
      });
    }
    
    // Sort by updated_at
    return processed.sort((a, b) => 
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );
  }, [currentThreads]);

  // Group threads by date, then by project within each date
  const groupedByDateThenProject: GroupedByDateThenProject = groupThreadsByDateThenProject(combinedThreads);
  
  // Initialize expanded projects - expand all by default
  useEffect(() => {
    const allProjectIds = Object.values(groupedByDateThenProject)
      .flatMap(dateGroup => Object.keys(dateGroup));
    if (allProjectIds.length > 0 && expandedProjects.size === 0) {
      setExpandedProjects(new Set(allProjectIds));
    }
  }, [groupedByDateThenProject]);
  
  const toggleProjectExpanded = (projectId: string) => {
    setExpandedProjects(prev => {
      const newSet = new Set(prev);
      if (newSet.has(projectId)) {
        newSet.delete(projectId);
      } else {
        newSet.add(projectId);
      }
      return newSet;
    });
  };

  // Handle creating a new chat with debounce and refetch
  const handleCreateNewChat = async (projectId: string) => {
    if (isCreatingChat) return; // Prevent double-clicks
    
    setIsCreatingChat(true);
    try {
      const result = await createThreadInProject(projectId);
      
      // Refetch threads and projects to update the sidebar
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: threadKeys.all }),
        queryClient.invalidateQueries({ queryKey: projectKeys.all }),
      ]);
      
      router.push(`/projects/${projectId}/thread/${result.thread_id}`);
      toast.success('New chat created');
    } catch (error) {
      console.error('Failed to create chat:', error);
      toast.error('Failed to create new chat');
    } finally {
      // Reset debounce after 1 second
      setTimeout(() => setIsCreatingChat(false), 1000);
    }
  };

  // Pagination helpers
  const pagination = threadsResponse?.pagination;
  const totalPages = pagination?.pages || 1;
  const canGoPrevious = currentPage > 1;
  const canGoNext = currentPage < totalPages;

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
          ) : null}
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
              // Show projects grouped by date
              <>
                {Object.entries(groupedByDateThenProject).map(([dateGroup, projectsInDate]) => (
                  <div key={dateGroup}>
                    <DateGroupHeader dateGroup={dateGroup} />
                    <div className="space-y-1.5">
                      {Object.values(projectsInDate).map((projectGroup: ProjectGroup) => {
                  const isExpanded = expandedProjects.has(projectGroup.projectId);
                  const projectThreads = projectGroup.threads;
                  const hasActiveThread = projectThreads.some(t => pathname?.includes(t.threadId));
                  const hasSingleChat = projectThreads.length === 1;
                  const singleThread = hasSingleChat ? projectThreads[0] : null;
                  
                  // Single chat - show simple card (original ThreadItem style)
                  if (hasSingleChat && singleThread) {
                    const isActive = pathname?.includes(singleThread.threadId) || false;
                    const isThreadLoading = loadingThreadId === singleThread.threadId;
                    const isAgentRunning = agentStatusMap.get(singleThread.threadId) || false;
                    
                    return (
                      <SingleChatCard
                        key={`project-${projectGroup.projectId}`}
                        thread={singleThread}
                        projectGroup={projectGroup}
                        isActive={isActive}
                        isThreadLoading={isThreadLoading}
                        isAgentRunning={isAgentRunning}
                        handleThreadClick={handleThreadClick}
                        handleDeleteThread={handleDeleteThread}
                        handleCreateNewChat={handleCreateNewChat}
                        isCreatingChat={isCreatingChat}
                      />
                    );
                  }
                  
                  // Multiple chats - show project with expandable threads
                  return (
                    <div 
                      key={`project-${projectGroup.projectId}`}
                      className="rounded-xl"
                    >
                      <Collapsible
                        open={isExpanded}
                        onOpenChange={() => toggleProjectExpanded(projectGroup.projectId)}
                      >
                        <CollapsibleTrigger asChild>
                          <div className={cn(
                            "flex items-center gap-2.5 px-2.5 py-2.5 cursor-pointer group/project rounded-xl transition-colors",
                            hasActiveThread ? "bg-muted" : "hover:bg-muted/30"
                          )}>
                            {/* Project Icon */}
                            <div className="flex items-center justify-center w-10 h-10 rounded-2xl bg-card border-[1.5px] border-border flex-shrink-0">
                              <ThreadIcon
                                iconName={projectGroup.iconName}
                                className="text-muted-foreground"
                                size={14}
                              />
                            </div>
                            
                            {/* Project Name & Chat Count */}
                            <div className="flex-1 min-w-0">
                              <span className="block text-sm truncate text-foreground/90">
                                {projectGroup.projectName}
                              </span>
                              <span className="text-[11px] text-muted-foreground">
                                {projectThreads.length} chats
                              </span>
                            </div>
                            
                            {/* Actions */}
                            <div className="flex items-center gap-1 flex-shrink-0">
                              {/* New chat button */}
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <button
                                    className="p-1.5 rounded-lg hover:bg-muted transition-colors text-muted-foreground opacity-0 group-hover/project:opacity-100 disabled:opacity-30 disabled:cursor-not-allowed"
                                    disabled={isCreatingChat}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleCreateNewChat(projectGroup.projectId);
                                    }}
                                  >
                                    {isCreatingChat ? (
                                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                    ) : (
                                      <Plus className="h-3.5 w-3.5" />
                                    )}
                                  </button>
                                </TooltipTrigger>
                                <TooltipContent side="right">
                                  {isCreatingChat ? 'Creating...' : 'New chat'}
                                </TooltipContent>
                              </Tooltip>
                              
                              {/* Chevron */}
                              <ChevronDown className={cn(
                                "h-4 w-4 text-muted-foreground transition-transform duration-200",
                                isExpanded ? "rotate-0" : "-rotate-90"
                              )} />
                            </div>
                          </div>
                        </CollapsibleTrigger>
                        
                        <CollapsibleContent>
                          <div className="ml-[26px] pl-3 border-l border-border/40 mt-1 pb-2 space-y-1">
                            {projectThreads.map((thread) => {
                              const isThreadActive = pathname?.includes(thread.threadId) || false;
                              const isRunning = agentStatusMap.get(thread.threadId) || false;

                              return (
                                <Link
                                  key={`thread-${thread.threadId}`}
                                  href={thread.url}
                                  onClick={(e) => handleThreadClick(e, thread.threadId, thread.url)}
                                  prefetch={false}
                                  className={cn(
                                    "flex items-center gap-2 px-2 py-1.5 text-sm rounded-lg transition-colors group/chat",
                                    isThreadActive 
                                      ? "bg-muted text-foreground font-medium" 
                                      : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
                                  )}
                                >
                                  {/* Status dot */}
                                  <div className={cn(
                                    "w-1.5 h-1.5 rounded-full flex-shrink-0 transition-colors",
                                    isRunning ? "bg-green-500 animate-pulse" : isThreadActive ? "bg-primary" : "bg-muted-foreground/30"
                                  )} />
                                    
                                    {/* Chat name */}
                                    <span className={cn(
                                      "flex-1 truncate",
                                      isThreadActive && "font-medium"
                                    )}>
                                      {thread.threadName}
                                    </span>
                                    
                                    {/* Menu */}
                                    <DropdownMenu>
                                      <DropdownMenuTrigger asChild>
                                        <button
                                          className="p-1 rounded-md hover:bg-accent transition-colors opacity-0 group-hover/chat:opacity-100"
                                          onClick={(e) => {
                                            e.preventDefault();
                                            e.stopPropagation();
                                          }}
                                        >
                                          <MoreHorizontal className="h-3.5 w-3.5" />
                                        </button>
                                      </DropdownMenuTrigger>
                                      <DropdownMenuContent align="end" className="w-40">
                                        <DropdownMenuItem
                                          onClick={(e) => {
                                            e.preventDefault();
                                            e.stopPropagation();
                                            handleDeleteThread(thread.threadId, thread.projectName);
                                          }}
                                        >
                                          <Trash2 className="mr-2 h-3.5 w-3.5" />
                                          Delete
                                        </DropdownMenuItem>
                                      </DropdownMenuContent>
                                    </DropdownMenu>
                                </Link>
                              );
                            })}
                          </div>
                        </CollapsibleContent>
                      </Collapsible>
                    </div>
                        );
                      })}
                    </div>
                  </div>
                ))}

              {/* Minimal pagination controls */}
              {pagination && totalPages > 1 && (
                <div className="px-3 py-3 mt-2">
                  <div className="flex items-center justify-center gap-4">
                    <button
                      onClick={handlePreviousPage}
                      disabled={!canGoPrevious || isThreadsFetching}
                      className={cn(
                        "p-1.5 rounded-md transition-all",
                        canGoPrevious && !isThreadsFetching
                          ? "text-muted-foreground hover:text-foreground hover:bg-muted"
                          : "text-muted-foreground/30 cursor-not-allowed"
                      )}
                    >
                      <ChevronLeft className="h-4 w-4" />
                    </button>
                    
                    <span className="text-xs text-muted-foreground flex items-center gap-1.5 tabular-nums">
                      {isThreadsFetching && (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      )}
                      <span className="font-medium">{currentPage}</span>
                      <span>/</span>
                      <span>{totalPages}</span>
                    </span>
                    
                    <button
                      onClick={handleNextPage}
                      disabled={!canGoNext || isThreadsFetching}
                      className={cn(
                        "p-1.5 rounded-md transition-all",
                        canGoNext && !isThreadsFetching
                          ? "text-muted-foreground hover:text-foreground hover:bg-muted"
                          : "text-muted-foreground/30 cursor-not-allowed"
                      )}
                    >
                      <ChevronRight className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              )}
              </>
            ) : (
              <div className="flex flex-col items-center justify-center py-12 px-6 text-center">
                <div className="flex items-center justify-center w-14 h-14 rounded-2xl bg-muted/30 border border-border mb-4">
                  <Frown className="h-6 w-6 text-muted-foreground/50" />
                </div>
                <p className="text-sm font-medium text-muted-foreground mb-1">
                  {t('noConversations')}
                </p>
                <p className="text-xs text-muted-foreground/60">
                  Start a new project to get going
                </p>
              </div>
            )}
          </>
        )}
      </div>

      {(isDeletingSingle || isDeletingMultiple) && totalToDelete > 0 && (
        <div className="mx-3 mt-3 p-3 bg-muted/30 rounded-xl border border-border">
          <div className="flex items-center justify-between text-xs text-muted-foreground mb-2">
            <span className="flex items-center gap-2">
              <Loader2 className="h-3 w-3 animate-spin" />
              Deleting...
            </span>
            <span className="tabular-nums font-medium">{Math.floor(deleteProgress)}%</span>
          </div>
          <div className="w-full bg-muted h-1.5 rounded-full overflow-hidden">
            <div
              className="bg-primary h-full transition-all duration-300 ease-out rounded-full"
              style={{ width: `${deleteProgress}%` }}
            />
          </div>
        </div>
      )}

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