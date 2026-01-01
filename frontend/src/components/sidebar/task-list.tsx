'use client';

import { useEffect, useState, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  MoreHorizontal,
  Trash2,
  Loader2,
  ChevronRight,
  ChevronLeft,
  Inbox,
} from "lucide-react"
import { TaskIcon } from "./task-icon"
import { toast } from "sonner"
import { usePathname, useRouter } from "next/navigation"
import { cn } from '@/lib/utils';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useSidebar } from '@/components/ui/sidebar';
import Link from "next/link"
import { DeleteConfirmationDialog } from "@/components/thread/DeleteConfirmationDialog"
import { useDeleteOperation } from '@/stores/delete-operation-store'
import { ThreadWithProject, ProjectGroup, GroupedByDateThenProject } from '@/hooks/sidebar/use-sidebar';
import { useDeleteThread, useProjects, groupThreadsByDateThenProject } from '@/hooks/sidebar/use-sidebar';
import { projectKeys, threadKeys } from '@/hooks/threads/keys';
import { useThreadAgentStatuses } from '@/hooks/threads';
import { formatDateForList } from '@/lib/utils/date-formatting';
import { useThreads } from '@/hooks/threads/use-threads';
import { useTranslations } from 'next-intl';
import { useMemo } from 'react';

// Minimal task item component matching the reference design
const TaskItem: React.FC<{
  thread: ThreadWithProject;
  projectGroup: ProjectGroup;
  isActive: boolean;
  isAgentRunning: boolean;
  handleThreadClick: (e: React.MouseEvent<HTMLAnchorElement>, threadId: string, url: string) => void;
  handleDeleteThread: (threadId: string, threadName: string) => void;
}> = ({
  thread,
  projectGroup,
  isActive,
  isAgentRunning,
  handleThreadClick,
  handleDeleteThread,
}) => {
  const [isHovering, setIsHovering] = useState(false);

  return (
    <Link
      href={thread.url}
      onClick={(e) => handleThreadClick(e, thread.threadId, thread.url)}
      prefetch={false}
      className="block group"
    >
      <div
        className={cn(
          "flex items-center gap-3 px-3 py-2 rounded-xl text-sm transition-all duration-150",
          isActive 
            ? "bg-foreground/[0.08] text-foreground" 
            : "text-muted-foreground hover:text-foreground hover:bg-foreground/[0.04]"
        )}
        onMouseEnter={() => setIsHovering(true)}
        onMouseLeave={() => setIsHovering(false)}
      >
        {/* Icon with running indicator */}
        <div className="relative flex-shrink-0">
          <div className={cn(
            "w-7 h-7 rounded-lg flex items-center justify-center transition-colors",
            isActive ? "bg-foreground/10" : "bg-foreground/[0.04]"
          )}>
            <TaskIcon
              iconName={projectGroup.iconName}
              className={cn(
                "transition-colors",
                isActive ? "text-foreground" : "text-muted-foreground"
              )}
              size={14}
            />
          </div>
          {isAgentRunning && (
            <div className="absolute -top-0.5 -right-0.5 w-2 h-2 bg-emerald-500 rounded-full border-2 border-background animate-pulse" />
          )}
        </div>
        
        {/* Title */}
        <span className="flex-1 truncate font-medium">
          {projectGroup.projectName}
        </span>
        
        {/* Actions */}
        <div className="flex-shrink-0">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className={cn(
                  "p-1 rounded-md transition-all text-muted-foreground hover:text-foreground hover:bg-foreground/[0.08]",
                  isHovering ? "opacity-100" : "opacity-0"
                )}
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
                className="text-destructive focus:text-destructive"
              >
                <Trash2 className="mr-2 h-3.5 w-3.5" />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </Link>
  );
};

export function TaskList() {
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

  // Pagination state
  const [currentPage, setCurrentPage] = useState(1);
  const pageLimit = 20;
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const {
    data: projects = [],
    isLoading: isProjectsLoading,
    error: projectsError
  } = useProjects();

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

  const currentThreads = threadsResponse?.threads || [];

  const previousTotalRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (threadsResponse?.pagination) {
      const currentTotal = threadsResponse.pagination.total;
      if (previousTotalRef.current !== undefined &&
        currentTotal < previousTotalRef.current &&
        currentPage > 1) {
        setCurrentPage(1);
      }
      previousTotalRef.current = currentTotal;
    }
  }, [threadsResponse?.pagination, currentPage]);

  const combinedThreads: ThreadWithProject[] = useMemo(() => {
    if (currentThreads.length === 0) {
      return [];
    }
    
    const processed: ThreadWithProject[] = [];
    
    for (const thread of currentThreads) {
      const projectId = thread.project_id;
      const project = thread.project;
      
      if (!projectId) {
        console.debug('Thread without project_id:', thread.thread_id);
        continue;
      }
      
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
    
    return processed.sort((a, b) => 
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );
  }, [currentThreads]);

  const groupedByDateThenProject: GroupedByDateThenProject = groupThreadsByDateThenProject(combinedThreads);

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

  const threadIds = combinedThreads.map(thread => thread.threadId);
  const agentStatusMap = useThreadAgentStatuses(threadIds);

  useEffect(() => {
    const handleProjectUpdate = (event: Event) => {
      const customEvent = event as CustomEvent;
      if (customEvent.detail) {
        const { projectId } = customEvent.detail;
        queryClient.invalidateQueries({ queryKey: projectKeys.details(projectId) });
        queryClient.invalidateQueries({ queryKey: projectKeys.lists() });
      }
    };

    window.addEventListener('project-updated', handleProjectUpdate as EventListener);
    return () => {
      window.removeEventListener('project-updated', handleProjectUpdate as EventListener);
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
      document.body.style.pointerEvents = "auto";
    };
  }, []);

  useEffect(() => {
    isNavigatingRef.current = false;
    document.body.style.pointerEvents = 'auto';
  }, [pathname]);

  const handleThreadClick = (e: React.MouseEvent<HTMLAnchorElement>, threadId: string, url: string) => {
    if (selectedThreads.has(threadId)) {
      e.preventDefault();
      return;
    }

    if (!e.metaKey) {
      setLoadingThreadId(threadId);
    }

    if (isMobile) {
      setOpenMobile(false);
    }
  }

  const handleDeleteThread = async (threadId: string, threadName: string) => {
    setThreadToDelete({ id: threadId, name: threadName });
    setIsDeleteDialogOpen(true);
  };

  const confirmDelete = async () => {
    if (!threadToDelete || isPerformingActionRef.current) return;

    isPerformingActionRef.current = true;
    setIsDeleteDialogOpen(false);

    const threadId = threadToDelete.id;
    const isActive = pathname?.includes(threadId);

    const currentThread = currentThreads.find(t => t.thread_id === threadId);
    const sandboxId = currentThread?.project?.sandbox?.id;

    await performDelete(
      threadId,
      isActive,
      async () => {
        deleteThreadMutation(
          { threadId, sandboxId },
          {
            onSuccess: () => {
              queryClient.invalidateQueries({ queryKey: threadKeys.lists() });
              toast.success('Task deleted');
            },
            onSettled: () => {
              setThreadToDelete(null);
              isPerformingActionRef.current = false;
            }
          }
        );
      },
      () => {
        setThreadToDelete(null);
        isPerformingActionRef.current = false;
      },
    );
  };

  const isInitialLoading = (isProjectsLoading || isThreadsLoading) && combinedThreads.length === 0;
  const isLoading = isInitialLoading;
  const hasError = projectsError || threadsError;

  if (hasError) {
    console.error('Error loading data:', { projectsError, threadsError });
  }

  return (
    <div className="h-full flex flex-col">
      <div 
        ref={scrollContainerRef} 
        className="flex-1 overflow-y-auto [&::-webkit-scrollbar]:hidden [-ms-overflow-style:'none'] [scrollbar-width:'none']"
      >
        {(state !== 'collapsed' || isMobile) && (
          <>
            {isLoading ? (
              <div className="space-y-1 py-1">
                {Array.from({ length: 5 }).map((_, index) => (
                  <div key={`skeleton-${index}`} className="flex items-center gap-3 px-3 py-2">
                    <div className="h-7 w-7 bg-foreground/[0.04] rounded-lg animate-pulse" />
                    <div className="h-4 bg-foreground/[0.04] rounded-md flex-1 animate-pulse" />
                  </div>
                ))}
              </div>
            ) : combinedThreads.length > 0 ? (
              <div className="space-y-0.5 py-1">
                {Object.entries(groupedByDateThenProject).map(([dateGroup, projectsInDate]) => (
                  <div key={dateGroup}>
                    {Object.values(projectsInDate).map((projectGroup: ProjectGroup) => {
                      const projectThreads = projectGroup.threads;
                      const singleThread = projectThreads[0];
                      
                      if (!singleThread) return null;
                      
                      const isActive = pathname?.includes(singleThread.threadId) || false;
                      const isAgentRunning = agentStatusMap.get(singleThread.threadId) || false;
                      
                      return (
                        <TaskItem
                          key={`project-${projectGroup.projectId}`}
                          thread={singleThread}
                          projectGroup={projectGroup}
                          isActive={isActive}
                          isAgentRunning={isAgentRunning}
                          handleThreadClick={handleThreadClick}
                          handleDeleteThread={handleDeleteThread}
                        />
                      );
                    })}
                  </div>
                ))}

                {/* Pagination */}
                {pagination && totalPages > 1 && (
                  <div className="flex items-center justify-center gap-3 py-3 mt-2">
                    <button
                      onClick={handlePreviousPage}
                      disabled={!canGoPrevious || isThreadsFetching}
                      className={cn(
                        "p-1.5 rounded-lg transition-all",
                        canGoPrevious && !isThreadsFetching
                          ? "text-muted-foreground hover:text-foreground hover:bg-foreground/[0.04]"
                          : "text-muted-foreground/30 cursor-not-allowed"
                      )}
                    >
                      <ChevronLeft className="h-4 w-4" />
                    </button>
                    
                    <span className="text-xs text-muted-foreground flex items-center gap-1.5 tabular-nums">
                      {isThreadsFetching && (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      )}
                      <span className="font-medium text-foreground">{currentPage}</span>
                      <span>/</span>
                      <span>{totalPages}</span>
                    </span>
                    
                    <button
                      onClick={handleNextPage}
                      disabled={!canGoNext || isThreadsFetching}
                      className={cn(
                        "p-1.5 rounded-lg transition-all",
                        canGoNext && !isThreadsFetching
                          ? "text-muted-foreground hover:text-foreground hover:bg-foreground/[0.04]"
                          : "text-muted-foreground/30 cursor-not-allowed"
                      )}
                    >
                      <ChevronRight className="h-4 w-4" />
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center py-12 px-4 text-center">
                <div className="flex items-center justify-center w-12 h-12 rounded-2xl bg-foreground/[0.04] mb-4">
                  <Inbox className="h-5 w-5 text-muted-foreground/50" />
                </div>
                <p className="text-sm font-medium text-muted-foreground mb-1">
                  {t('noConversations')}
                </p>
                <p className="text-xs text-muted-foreground/60">
                  Create a new task to get started
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
          isDeleting={isDeletingSingle}
        />
      )}
    </div>
  );
}

// Legacy export for backward compatibility
export const NavAgents = TaskList;

