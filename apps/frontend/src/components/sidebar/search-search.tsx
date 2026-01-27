'use client';

import * as React from 'react';
import { useState, useEffect, useMemo, ReactNode } from 'react';
import { Search, X, FileText, Loader2 } from 'lucide-react';
import { KortixLoader } from '@/components/ui/kortix-loader';
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
import { useProjects, useThreads, processThreadsWithProjects } from '@/hooks/sidebar/use-sidebar';
import { useThreadSearch } from '@/hooks/threads/use-thread-search';
import { Project } from '@/lib/api/threads';
import Link from 'next/link';

// Thread with associated project info for display in sidebar & search
type ThreadWithProject = {
  threadId: string;
  projectId: string;
  projectName: string;
  url: string;
  updatedAt: string;
  textPreview?: string;
};

// Highlight matching terms in text
function highlightText(text: string, query: string): ReactNode {
  if (!query.trim() || !text) return text;

  const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 1);
  if (words.length === 0) return text;

  const pattern = new RegExp(`(${words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
  const parts = text.split(pattern);

  return parts.map((part, i) => {
    const isMatch = words.some(w => part.toLowerCase() === w);
    return isMatch ? (
      <mark key={i} className="bg-yellow-200 dark:bg-yellow-800 rounded px-0.5">
        {part}
      </mark>
    ) : part;
  });
}

export function SidebarSearch() {
  const [query, setQuery] = useState('');
  const [threads, setThreads] = useState<ThreadWithProject[]>([]);
  const [loadingThreadId, setLoadingThreadId] = useState<string | null>(null);
  const router = useRouter();
  const pathname = usePathname();
  const { state } = useSidebar();

  const { data: projects = [], isLoading: projectsLoading } = useProjects();
  const { data: threadsResponse, isLoading: threadsLoading } = useThreads();

  const {
    results: searchResults,
    isSearching,
    shouldSearch,
  } = useThreadSearch(query, 20);

  const allThreads = threadsResponse?.threads || [];
  const isLoading = projectsLoading || threadsLoading;

  const sortThreads = (threadsList: ThreadWithProject[]): ThreadWithProject[] => {
    return [...threadsList].sort((a, b) => {
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });
  };

  useEffect(() => {
    if (isLoading) return;

    if (!allThreads.length) {
      setThreads([]);
      return;
    }

    let effectiveProjects = projects;
    if (!projects.length) {
      const projectsMap = new Map<string, Project>();
      allThreads.forEach((thread: any) => {
        if (thread.project && thread.project_id) {
          const project = thread.project;
          if (!projectsMap.has(project.project_id)) {
            projectsMap.set(project.project_id, {
              id: project.project_id,
              name: project.name || '',
              description: project.description || '',
              created_at: project.created_at,
              updated_at: project.updated_at,
              sandbox: project.sandbox || {
                id: '',
                pass: '',
                vnc_preview: '',
                sandbox_url: '',
              },
              icon_name: project.icon_name,
            });
          }
        }
      });
      effectiveProjects = Array.from(projectsMap.values());
    }

    const threadsWithProjects = processThreadsWithProjects(allThreads, effectiveProjects);
    const sortedThreads = sortThreads(threadsWithProjects);
    setThreads(sortedThreads);
  }, [projects, allThreads, isLoading]);

  const threadMap = useMemo(() => {
    const map = new Map<string, ThreadWithProject>();
    for (const thread of threads) {
      map.set(thread.threadId, thread);
    }
    return map;
  }, [threads]);

  const filteredThreads = useMemo(() => {
    if (shouldSearch && searchResults.length > 0) {
      // Deduplicate by thread_id, keeping highest score
      const seen = new Map<string, { score: number; textPreview: string; projectId: string | null; projectName: string; updatedAt: string | null }>();
      for (const result of searchResults) {
        const existing = seen.get(result.thread_id);
        if (!existing || result.score > existing.score) {
          seen.set(result.thread_id, {
            score: result.score,
            textPreview: result.text_preview,
            projectId: result.project_id,
            projectName: result.project_name,
            updatedAt: result.updated_at,
          });
        }
      }

      const semanticResults: ThreadWithProject[] = [];
      for (const [threadId, data] of seen) {
        // Try local thread first, fall back to search result metadata
        const thread = threadMap.get(threadId);
        if (thread) {
          semanticResults.push({
            ...thread,
            textPreview: data.textPreview,
          });
        } else if (data.projectId) {
          semanticResults.push({
            threadId,
            projectId: data.projectId,
            projectName: data.projectName || 'Unnamed Project',
            url: `/projects/${data.projectId}/thread/${threadId}`,
            updatedAt: data.updatedAt || new Date().toISOString(),
            textPreview: data.textPreview,
          });
        }
      }
      return semanticResults;
    }

    if (shouldSearch && isSearching) {
      return [];
    }

    if (query.trim()) {
      const lowerQuery = query.toLowerCase();
      return threads.filter((thread) =>
        thread.projectName.toLowerCase().includes(lowerQuery)
      );
    }

    return threads;
  }, [query, shouldSearch, searchResults, isSearching, threads, threadMap]);

  useEffect(() => {
    setLoadingThreadId(null);
  }, [pathname]);

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
          {isSearching ? (
            <div className="absolute right-2 top-1/2 -translate-y-1/2">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          ) : query ? (
            <button
              onClick={() => setQuery('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-sm
                        opacity-70 hover:opacity-100 focus:outline-none"
            >
              <X className="h-4 w-4" />
              <span className="sr-only">Clear</span>
            </button>
          ) : null}
        </div>
      </div>

      <SidebarGroupLabel>
        {query ? (isSearching && shouldSearch ? 'Searching...' : 'Search Results') : 'Recent'}
      </SidebarGroupLabel>
      <SidebarMenu className="overflow-y-auto max-h-[calc(100vh-270px)] [&::-webkit-scrollbar]:hidden [-ms-overflow-style:'none'] [scrollbar-width:'none']">
        {isLoading ? (
          Array.from({ length: 3 }).map((_, index) => (
            <SidebarMenuItem key={`skeleton-${index}`}>
              <SidebarMenuButton>
                <div className="h-4 w-4 bg-sidebar-foreground/10 rounded-md animate-pulse"></div>
                <div className="h-3 bg-sidebar-foreground/10 rounded w-3/4 animate-pulse"></div>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))
        ) : isSearching && shouldSearch ? (
          <SidebarMenuItem>
            <SidebarMenuButton className="text-sidebar-foreground/70">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>Searching...</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        ) : filteredThreads.length > 0 ? (
          filteredThreads.map((thread, index) => {
            const isActive = pathname?.includes(thread.threadId) || false;
            const isThreadLoading = loadingThreadId === thread.threadId;
            const updatedDate = new Date(thread.updatedAt);
            const isToday = new Date().toDateString() === updatedDate.toDateString();
            const isYesterday = new Date(Date.now() - 86400000).toDateString() === updatedDate.toDateString();

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
                  className={isActive ? 'bg-accent text-accent-foreground font-medium' : ''}
                >
                  <Link
                    href={thread.url}
                    onClick={(e) => handleThreadClick(e, thread.threadId, thread.url)}
                    prefetch={false}
                    className="flex flex-col items-start w-full py-2"
                  >
                    <div className="flex items-center justify-between w-full">
                      <div className="flex items-center">
                        {isThreadLoading ? (
                          <KortixLoader size="small" className="mr-2" />
                        ) : (
                          <FileText className="mr-2 h-4 w-4 shrink-0" />
                        )}
                        <span className="truncate">{thread.projectName}</span>
                      </div>
                      <span className="ml-2 text-xs text-muted-foreground shrink-0">
                        {dateDisplay}
                      </span>
                    </div>
                    {thread.textPreview && shouldSearch && (
                      <p className="text-xs text-muted-foreground mt-1 line-clamp-1 pl-6 w-full">
                        {highlightText(thread.textPreview.slice(0, 100), query)}
                      </p>
                    )}
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            );
          })
        ) : (
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
