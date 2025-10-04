'use client';

import * as React from 'react';
import { useState, useEffect, useCallback } from 'react';
import { Search, X, FileText, Loader2 } from 'lucide-react';
import { useRouter, usePathname } from 'next/navigation';
import { format } from 'date-fns';

import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@/components/ui/sidebar';
import { useProjects, useAllThreads } from '@/hooks/react-query';
import Link from 'next/link';

// Thread with associated project info for display in sidebar & search
type ThreadWithProject = {
  threadId: string;
  projectId: string;
  projectName: string;
  url: string;
  updatedAt: string;
};

export function SidebarSearch() {
  const [query, setQuery] = useState('');
  const [threads, setThreads] = useState<ThreadWithProject[]>([]);
  const [filteredThreads, setFilteredThreads] = useState<ThreadWithProject[]>(
    [],
  );
  const [loadingThreadId, setLoadingThreadId] = useState<string | null>(null);
  const router = useRouter();
  const pathname = usePathname();
  const { state } = useSidebar();

  // Use React Query hooks
  const { data: projects = [], isLoading: projectsLoading } = useProjects();
  const { data: allThreads = [], isLoading: threadsLoading } = useAllThreads();
  const isLoading = projectsLoading || threadsLoading;

  // Helper to sort threads by updated_at (most recent first)
  const sortThreads = (
    threadsList: ThreadWithProject[],
  ): ThreadWithProject[] => {
    return [...threadsList].sort((a, b) => {
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });
  };

  // Process threads with project data when data changes
  useEffect(() => {
    if (!projects.length || !allThreads.length) {
      setThreads([]);
      setFilteredThreads([]);
      return;
    }

    // Create a map of projects by ID for faster lookups
    const projectsById = new Map();
    projects.forEach((project) => {
      projectsById.set(project.id, project);
    });

    // Create display objects for threads with their project info
    const threadsWithProjects: ThreadWithProject[] = [];

    for (const thread of allThreads) {
      const projectId = thread.project_id;
      // Skip threads without a project ID
      if (!projectId) continue;

      // Get the associated project
      const project = projectsById.get(projectId);
      if (!project) continue;

      let displayName = project.name || 'Unnamed Project';

      // Add to our list
      threadsWithProjects.push({
        threadId: thread.thread_id,
        projectId: projectId,
        projectName: displayName,
        url: `/projects/${projectId}/thread/${thread.thread_id}`,
        updatedAt:
          thread.updated_at || project.updated_at || new Date().toISOString(),
      });
    }

    // Set threads, ensuring consistent sort order
    const sortedThreads = sortThreads(threadsWithProjects);
    setThreads(sortedThreads);
    setFilteredThreads(sortedThreads);
  }, [projects, allThreads]);

  // Filter threads based on search query
  const filterThreads = useCallback(
    (searchQuery: string) => {
      if (!searchQuery.trim()) {
        setFilteredThreads(threads);
        return;
      }

      const query = searchQuery.toLowerCase();
      const filtered = threads.filter((thread) =>
        thread.projectName.toLowerCase().includes(query),
      );

      setFilteredThreads(filtered);
    },
    [threads],
  );

  // Update filtered threads when query changes
  useEffect(() => {
    filterThreads(query);
  }, [query, filterThreads]);

  // Data is automatically loaded by React Query hooks

  // Reset loading state when navigation completes
  useEffect(() => {
    setLoadingThreadId(null);
  }, [pathname]);

  // Handle keyboard shortcut to focus search (CMD+K or CTRL+K)
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if ((e.key === 'k' && (e.metaKey || e.ctrlKey)) || e.key === '/') {
        e.preventDefault();
        document.getElementById('sidebar-search-input')?.focus();
      }
    };

    document.addEventListener('keydown', down);
    return () => document.removeEventListener('keydown', down);
  }, []);

  // Handle thread click with loading state
  const handleThreadClick = (
    e: React.MouseEvent<HTMLAnchorElement>,
    threadId: string,
    url: string,
  ) => {
    e.preventDefault();
    setLoadingThreadId(threadId);
    router.push(url);
  };

  return (
    <SidebarGroup>
      {/* Search input in sidebar */}
      <div className="flex items-center px-2 pt-3 pb-2">
        <div className="relative w-full">
          <Search className="absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            id="sidebar-search-input"
            type="text"
            placeholder="Search..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 pl-8 pr-8
                      text-sm transition-colors placeholder:text-muted-foreground
                      focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
          {query && (
            <button
              onClick={() => setQuery('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-sm
                        opacity-70 hover:opacity-100 focus:outline-none"
            >
              <X className="h-4 w-4" />
              <span className="sr-only">Clear</span>
            </button>
          )}
        </div>
      </div>

      {/* Search results */}
      <SidebarGroupLabel>
        {query ? 'Search Results' : 'Recent'}
      </SidebarGroupLabel>
      <SidebarMenu className="overflow-y-auto max-h-[calc(100vh-270px)] [&::-webkit-scrollbar]:hidden [-ms-overflow-style:'none'] [scrollbar-width:'none']">
        {isLoading ? (
          // Show skeleton loaders while loading
          Array.from({ length: 3 }).map((_, index) => (
            <SidebarMenuItem key={`skeleton-${index}`}>
              <SidebarMenuButton>
                <div className="h-4 w-4 bg-sidebar-foreground/10 rounded-md animate-pulse"></div>
                <div className="h-3 bg-sidebar-foreground/10 rounded w-3/4 animate-pulse"></div>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))
        ) : filteredThreads.length > 0 ? (
          // Show all filtered threads
          filteredThreads.map((thread, index) => {
            // Check if this thread is currently active
            const isActive = pathname?.includes(thread.threadId) || false;
            const isThreadLoading = loadingThreadId === thread.threadId;
            const updatedDate = new Date(thread.updatedAt);
            const isToday =
              new Date().toDateString() === updatedDate.toDateString();
            const isYesterday =
              new Date(Date.now() - 86400000).toDateString() ===
              updatedDate.toDateString();

            // Format date as "today", "yesterday", or formatted date
            let dateDisplay;
            if (isToday) {
              dateDisplay = 'Today';
            } else if (isYesterday) {
              dateDisplay = 'Yesterday';
            } else {
              dateDisplay = format(updatedDate, 'MMM d, yyyy');
            }

            return (
              <SidebarMenuItem key={`thread-${thread.threadId}-${index}`}>
                <SidebarMenuButton
                  asChild
                  className={
                    isActive
                      ? 'bg-accent text-accent-foreground font-medium'
                      : ''
                  }
                >
                  <Link
                    href={thread.url}
                    onClick={(e) =>
                      handleThreadClick(e, thread.threadId, thread.url)
                    }
                    prefetch={false}
                    className="flex items-center justify-between w-full"
                  >
                    <div className="flex items-center">
                      {isThreadLoading ? (
                        <Loader2 className="mr-2 h-4 w-4 shrink-0 animate-spin" />
                      ) : (
                        <FileText className="mr-2 h-4 w-4 shrink-0" />
                      )}
                      <span className="truncate">{thread.projectName}</span>
                    </div>
                    <span className="ml-2 text-xs text-muted-foreground shrink-0">
                      {dateDisplay}
                    </span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            );
          })
        ) : (
          // Empty state
          <SidebarMenuItem>
            <SidebarMenuButton className="text-sidebar-foreground/70">
              <FileText className="h-4 w-4" />
              <span>{query ? 'No results found' : 'No agents yet'}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        )}
      </SidebarMenu>
    </SidebarGroup>
  );
}
