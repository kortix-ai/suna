'use client';

import { useEffect, useState, useRef, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  MoreHorizontal,
  Trash2,
  Loader2,
  Frown,
} from "lucide-react";
import { ThreadIcon } from "./thread-icon";
import { toast } from "sonner";
import { usePathname, useRouter } from "next/navigation";
import { cn } from '@/lib/utils';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useSidebar } from '@/components/ui/sidebar';
import Link from "next/link";
import { DeleteConfirmationDialog } from "@/components/thread/DeleteConfirmationDialog";
import { useDeleteOperation } from '@/stores/delete-operation-store';
import { ThreadWithProject } from '@/hooks/sidebar/use-sidebar';
import { useDeleteThread, useProjects } from '@/hooks/sidebar/use-sidebar';
import { threadKeys } from '@/hooks/threads/keys';
import { useThreadAgentStatuses } from '@/hooks/threads';
import { formatDateForList } from '@/lib/utils/date-formatting';
import { useThreads } from '@/hooks/threads/use-threads';
import { useTranslations } from 'next-intl';

// Task item component matching Manus design
const TaskItem: React.FC<{
  thread: ThreadWithProject;
  isActive: boolean;
  isLoading: boolean;
  isRunning: boolean;
  onNavigate: (e: React.MouseEvent<HTMLAnchorElement>, threadId: string, url: string) => void;
  onDelete: (threadId: string, threadName: string) => void;
}> = ({
  thread,
  isActive,
  isLoading,
  isRunning,
  onNavigate,
  onDelete,
}) => {
  const [isHovering, setIsHovering] = useState(false);

  return (
    <Link
      href={thread.url}
      onClick={(e) => onNavigate(e, thread.threadId, thread.url)}
      prefetch={false}
      className={cn(
        "group flex items-center gap-2.5 px-3 py-2 rounded-xl transition-all",
        isActive 
          ? "bg-accent text-accent-foreground" 
          : "hover:bg-accent/50 text-foreground/80 hover:text-foreground"
      )}
      onMouseEnter={() => setIsHovering(true)}
      onMouseLeave={() => setIsHovering(false)}
    >
      {/* Icon with optional running indicator */}
      <div className="relative flex-shrink-0">
        {isLoading ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        ) : (
          <ThreadIcon
            iconName={thread.iconName}
            className="text-muted-foreground"
            size={16}
          />
        )}
        {/* Running indicator - red dot badge like Manus */}
        {isRunning && (
          <div className="absolute -top-1 -right-1 flex items-center justify-center">
            <span className="relative flex h-2.5 w-2.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-red-500"></span>
            </span>
          </div>
        )}
      </div>

      {/* Task name */}
      <span className={cn(
        "flex-1 text-[13px] truncate",
        isActive && "font-medium"
      )}>
        {thread.projectName}
      </span>

      {/* Menu button - appears on hover */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            className={cn(
              "p-1 rounded-md hover:bg-accent transition-all",
              isHovering ? "opacity-100" : "opacity-0"
            )}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
          >
            <MoreHorizontal className="h-3.5 w-3.5 text-muted-foreground" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-40">
          <DropdownMenuItem
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onDelete(thread.threadId, thread.projectName);
            }}
            className="text-destructive focus:text-destructive"
          >
            <Trash2 className="mr-2 h-3.5 w-3.5" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </Link>
  );
};

export function NavTasks() {
  const t = useTranslations('sidebar');
  const { isMobile, state, setOpenMobile } = useSidebar();
  const [loadingThreadId, setLoadingThreadId] = useState<string | null>(null);
  const pathname = usePathname();
  const router = useRouter();
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [threadToDelete, setThreadToDelete] = useState<{ id: string; name: string } | null>(null);
  const isNavigatingRef = useRef(false);
  const { performDelete } = useDeleteOperation();
  const isPerformingActionRef = useRef(false);
  const queryClient = useQueryClient();
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const {
    data: projects = [],
    isLoading: isProjectsLoading,
    error: projectsError
  } = useProjects();

  const {
    data: threadsResponse,
    isLoading: isThreadsLoading,
    error: threadsError
  } = useThreads({
    limit: 500,
  });

  const { mutate: deleteThreadMutation, isPending: isDeletingSingle } = useDeleteThread();

  const currentThreads = threadsResponse?.threads || [];

  // Process threads directly
  const combinedThreads: ThreadWithProject[] = useMemo(() => {
    if (currentThreads.length === 0) {
      return [];
    }
    
    const processed: ThreadWithProject[] = [];
    
    for (const thread of currentThreads) {
      const projectId = thread.project_id;
      const project = thread.project;
      
      if (!projectId) {
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

  // Track agent running status for all threads
  const threadIds = combinedThreads.map(thread => thread.threadId);
  const agentStatusMap = useThreadAgentStatuses(threadIds);

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
    if (!e.metaKey) {
      setLoadingThreadId(threadId);
    }

    if (isMobile) {
      setOpenMobile(false);
    }
  };

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

    const thread = combinedThreads.find(t => t.threadId === threadId);
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
              toast.success('Task deleted successfully');
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
  const hasError = projectsError || threadsError;

  if (hasError) {
    console.error('Error loading data:', { projectsError, threadsError });
  }

  return (
    <div className="flex-1 overflow-hidden flex flex-col min-h-0">
      <div className="relative flex-1 overflow-hidden flex flex-col min-h-0">
        {/* Top fade gradient */}
        <div className="pointer-events-none absolute top-0 left-0 right-0 h-4 bg-gradient-to-b from-sidebar to-transparent z-10" />
        
        <div 
          ref={scrollContainerRef} 
          className="flex-1 overflow-y-auto [&::-webkit-scrollbar]:hidden [-ms-overflow-style:'none'] [scrollbar-width:'none'] pb-4 pt-1 px-1"
        >
          {(state !== 'collapsed' || isMobile) && (
            <>
              {isInitialLoading ? (
                <div className="space-y-1">
                  {Array.from({ length: 8 }).map((_, index) => (
                    <div key={`skeleton-${index}`} className="flex items-center gap-2.5 px-3 py-2">
                      <div className="h-4 w-4 bg-muted/30 rounded animate-pulse"></div>
                      <div className="h-3.5 bg-muted/30 rounded flex-1 animate-pulse"></div>
                    </div>
                  ))}
                </div>
              ) : combinedThreads.length > 0 ? (
                <div className="space-y-0.5">
                  {combinedThreads.map((thread) => {
                    const isActive = pathname?.includes(thread.threadId) || false;
                    const isThreadLoading = loadingThreadId === thread.threadId;
                    const isAgentRunning = agentStatusMap.get(thread.threadId) || false;

                    return (
                      <TaskItem
                        key={thread.threadId}
                        thread={thread}
                        isActive={isActive}
                        isLoading={isThreadLoading}
                        isRunning={isAgentRunning}
                        onNavigate={handleThreadClick}
                        onDelete={handleDeleteThread}
                      />
                    );
                  })}
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center py-12 px-4 text-center">
                  <div className="flex items-center justify-center w-12 h-12 rounded-xl bg-muted/30 mb-4">
                    <Frown className="h-5 w-5 text-muted-foreground/50" />
                  </div>
                  <p className="text-[13px] text-muted-foreground">
                    {t('noConversations')}
                  </p>
                  <p className="text-xs text-muted-foreground/60 mt-1">
                    Start a new task to get going
                  </p>
                </div>
              )}
            </>
          )}
        </div>
        
        {/* Bottom fade gradient */}
        <div className="pointer-events-none absolute bottom-0 left-0 right-0 h-8 bg-gradient-to-t from-sidebar to-transparent z-10" />
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

