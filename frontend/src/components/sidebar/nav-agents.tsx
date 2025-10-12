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
  Check,
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
import { useDeleteOperation } from '@/contexts/DeleteOperationContext'
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { ThreadWithProject, GroupedThreads } from '@/hooks/react-query/sidebar/use-sidebar';
import { processThreadsWithProjects, useDeleteMultipleThreads, useDeleteThread, useProjects, useThreads, groupThreadsByDate } from '@/hooks/react-query/sidebar/use-sidebar';
import { projectKeys, threadKeys } from '@/hooks/react-query/sidebar/keys';
import { useThreadAgentStatuses } from '@/hooks/use-thread-agent-status';

// Component for date group headers
const DateGroupHeader: React.FC<{ dateGroup: string; count: number }> = ({ dateGroup, count }) => {
  return (
    <div className="px-2 py-1 mb-1 mt-3 first:mt-0">
      <div className="text-xs font-medium text-muted-foreground/80 uppercase tracking-wider">
        {dateGroup} ({count})
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
  isAgentRunning = false,
  handleThreadClick, 
  toggleThreadSelection, 
  handleDeleteThread, 
  setSelectedItem, 
  setShowShareModal,
  isMobile 
}) => {
  return (
    <SidebarMenuItem key={`thread-${thread.threadId}`} className="group/row">
      <SidebarMenuButton
        asChild
        className={`relative ${isActive
          ? 'bg-accent text-accent-foreground font-medium'
          : isSelected
            ? 'bg-primary/10'
            : ''
          }`}
      >
        <div className="flex items-center w-full">
          <Link
            href={thread.url}
            onClick={(e) =>
              handleThreadClick(e, thread.threadId, thread.url)
            }
            prefetch={false}
            className="flex items-center flex-1 min-w-0 touch-manipulation"
          >
            {isThreadLoading ? (
              <Loader2 className="h-4 w-4 animate-spin mr-2 flex-shrink-0" />
            ) : (
              <ThreadIcon 
                iconName={thread.iconName} 
                className="mr-2" 
                size={16} 
              />
            )}
            <span className="truncate">{thread.projectName}</span>
          </Link>
          
          {/* Running status indicator */}
          {isAgentRunning && (
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="mr-1 flex-shrink-0 w-2 h-2 rounded-full bg-green-500 animate-pulse" />
              </TooltipTrigger>
              <TooltipContent>
                Agent is running
              </TooltipContent>
            </Tooltip>
          )}
          
          {/* Checkbox - only visible on hover of this specific area */}
          <div
            className="mr-1 flex-shrink-0 w-4 h-4 flex items-center justify-center group/checkbox"
            onClick={(e) => toggleThreadSelection(thread.threadId, e)}
          >
            <div
              className={`h-4 w-4 border rounded cursor-pointer transition-all duration-150 flex items-center justify-center ${isSelected
                ? 'opacity-100 bg-primary border-primary hover:bg-primary/90'
                : 'opacity-0 group-hover/checkbox:opacity-100 border-muted-foreground/30 bg-background hover:bg-muted/50'
                }`}
            >
              {isSelected && <Check className="h-3 w-3 text-primary-foreground" />}
            </div>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className="cursor-pointer flex-shrink-0 w-4 h-4 flex items-center justify-center hover:bg-muted/50 rounded transition-all duration-150 text-muted-foreground hover:text-foreground opacity-0 group-hover/row:opacity-100"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  document.body.style.pointerEvents = 'auto';
                }}
              >
                <MoreHorizontal className="h-4 w-4" />
                <span className="sr-only">More actions</span>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              className="w-56 rounded-lg"
              side={isMobile ? 'bottom' : 'right'}
              align={isMobile ? 'end' : 'start'}
            >
              <DropdownMenuItem onClick={() => {
                setSelectedItem({ threadId: thread?.threadId, projectId: thread?.projectId })
                setShowShareModal(true)
              }}>
                <ExternalLink className="text-muted-foreground" />
                <span>Share</span>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <a
                  href={thread.url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <ArrowUpRight className="text-muted-foreground" />
                  <span>Open in New Tab</span>
                </a>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() =>
                  handleDeleteThread(
                    thread.threadId,
                    thread.projectName,
                  )
                }
              >
                <Trash2 className="text-muted-foreground" />
                <span>Delete</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </SidebarMenuButton>
    </SidebarMenuItem>
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

  const {
    data: projects = [],
    isLoading: isProjectsLoading,
    error: projectsError
  } = useProjects();

  const {
    data: threads = [],
    isLoading: isThreadsLoading,
    error: threadsError
  } = useThreads();

  const { mutate: deleteThreadMutation, isPending: isDeletingSingle } = useDeleteThread();
  const {
    mutate: deleteMultipleThreadsMutation,
    isPending: isDeletingMultiple
  } = useDeleteMultipleThreads();

  const combinedThreads: ThreadWithProject[] =
    !isProjectsLoading && !isThreadsLoading ?
      processThreadsWithProjects(threads, projects) : [];

  // Separate trigger threads from regular threads
  const regularThreads = combinedThreads.filter(thread => !thread.projectName?.startsWith('Trigger: '));
  const triggerThreads = combinedThreads.filter(thread => thread.projectName?.startsWith('Trigger: '));
  
  const groupedThreads: GroupedThreads = groupThreadsByDate(regularThreads);
  const groupedTriggerThreads: GroupedThreads = groupThreadsByDate(triggerThreads);

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
      return newSelection;
    });
  };

  // Select all threads
  const selectAllThreads = () => {
    const allThreadIds = combinedThreads.map(thread => thread.threadId);
    setSelectedThreads(new Set(allThreadIds));
  };

  // Deselect all threads
  const deselectAllThreads = () => {
    setSelectedThreads(new Set());
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
  const isLoading = isProjectsLoading || isThreadsLoading;
  const hasError = projectsError || threadsError;

  if (hasError) {
    console.error('Error loading data:', { projectsError, threadsError });
  }

  return (
    <SidebarGroup>
      <div className="flex justify-between items-center">
        <SidebarGroupLabel>Tasks</SidebarGroupLabel>
        {(state !== 'collapsed' || isMobile) ? (
          <div className="flex items-center space-x-1">
            {selectedThreads.size > 0 ? (
              <>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={deselectAllThreads}
                  className="h-7 w-7"
                >
                  <X className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={selectAllThreads}
                  disabled={selectedThreads.size === combinedThreads.length}
                  className="h-7 w-7"
                >
                  <Check className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={handleMultiDelete}
                  className="h-7 w-7 text-destructive"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </>
            ) : null}
          </div>
        ) : null}
      </div>

      <SidebarMenu className="overflow-y-auto max-h-[calc(100vh-200px)] [&::-webkit-scrollbar]:hidden [-ms-overflow-style:'none'] [scrollbar-width:'none']">


        {(state !== 'collapsed' || isMobile) && (
          <>
            {isLoading ? (
              Array.from({ length: 3 }).map((_, index) => (
                <SidebarMenuItem key={`skeleton-${index}`}>
                  <SidebarMenuButton>
                    <div className="h-4 w-4 bg-sidebar-foreground/10 rounded-md animate-pulse"></div>
                    <div className="h-3 bg-sidebar-foreground/10 rounded w-3/4 animate-pulse"></div>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))
              ) : (regularThreads.length > 0 || triggerThreads.length > 0) ? (
                <>
                {triggerThreads.length > 0 && (
                  <Collapsible defaultOpen={false} className="group/collapsible w-full mb-3">
                    <SidebarMenuItem>
                      <CollapsibleTrigger asChild>
                        <SidebarMenuButton className="w-full">
                          <ChevronRight className="transition-transform h-4 w-4 group-data-[state=open]/collapsible:rotate-90" />
                          <Folder className="h-4 w-4" />
                          <span className="flex-1 text-left">Trigger Runs ({triggerThreads.length})</span>
                        </SidebarMenuButton>
                      </CollapsibleTrigger>
                    </SidebarMenuItem>
                    <CollapsibleContent>
                      <div className="pl-6">
                        {Object.entries(groupedTriggerThreads).map(([dateGroup, threadsInGroup]) => (
                          <div key={`trigger-${dateGroup}`}>
                            <DateGroupHeader dateGroup={dateGroup} count={threadsInGroup.length} />
                            {threadsInGroup.map((thread) => {
                              const isActive = pathname?.includes(thread.threadId) || false;
                              const isThreadLoading = loadingThreadId === thread.threadId;
                              const isSelected = selectedThreads.has(thread.threadId);

                              return (
                                <ThreadItem
                                  key={`trigger-thread-${thread.threadId}`}
                                  thread={thread}
                                  isActive={isActive}
                                  isThreadLoading={isThreadLoading}
                                  isSelected={isSelected}
                                  selectedThreads={selectedThreads}
                                  loadingThreadId={loadingThreadId}
                                  pathname={pathname}
                                  isMobile={isMobile}
                                  isAgentRunning={agentStatusMap.get(thread.threadId) || false}
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
                      </div>
                    </CollapsibleContent>
                  </Collapsible>
                )}
                  {Object.entries(groupedThreads).map(([dateGroup, threadsInGroup]) => (
                    <div key={dateGroup}>
                      <DateGroupHeader dateGroup={dateGroup} count={threadsInGroup.length} />
                      {threadsInGroup.map((thread) => {
                        const isActive = pathname?.includes(thread.threadId) || false;
                        const isThreadLoading = loadingThreadId === thread.threadId;
                        const isSelected = selectedThreads.has(thread.threadId);

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
                            isAgentRunning={agentStatusMap.get(thread.threadId) || false}
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
                </>
              ) : (
              <SidebarMenuItem>
                <SidebarMenuButton className="text-sidebar-foreground/70">
                  <span>No tasks yet</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            )}
          </>
        )}
      </SidebarMenu>

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
    </SidebarGroup>
  );
}