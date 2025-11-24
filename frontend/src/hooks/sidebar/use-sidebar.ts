'use client';

import { Project } from "@/lib/api/threads";
import { Thread } from "@/lib/api/threads";

// Re-export hooks from their proper locations for backward compatibility
export { useProjects, usePublicProjectsQuery, useUpdateProject, useDeleteProject } from '../threads/use-project';
export { useThreads } from '../threads/use-threads';
export { useDeleteThread, useDeleteMultipleThreads } from '../threads/use-thread-mutations';

// Sidebar-specific utility types and functions
export type ThreadWithProject = {
  threadId: string;
  projectId: string;
  projectName: string;
  url: string;
  updatedAt: string;
  // Icon system field for thread categorization
  iconName?: string | null;
};

export const processThreadsWithProjects = (
  threads: Thread[],
  projects: Project[]
): ThreadWithProject[] => {
  const projectsById = new Map<string, Project>();
  projects.forEach((project) => {
    projectsById.set(project.id, project);
  });

  const threadsWithProjects: ThreadWithProject[] = [];

  for (const thread of threads) {
    const projectId = thread.project_id;
    if (!projectId) continue;

    const project = projectsById.get(projectId);
    if (!project) {
      continue;
    }
    // Use dedicated icon_name field from backend
    let displayName = project.name || 'Unnamed Project';
    const iconName = project.icon_name; // Get icon from dedicated database field

    threadsWithProjects.push({
      threadId: thread.thread_id,
      projectId: projectId,
      projectName: displayName,
      url: `/projects/${projectId}/thread/${thread.thread_id}`,
      updatedAt:
        thread.updated_at || project.updated_at || new Date().toISOString(),
      // Use dedicated field or parsed embedded data
      iconName: iconName,
    });
  }

  return sortThreads(threadsWithProjects);
};

export const sortThreads = (
  threadsList: ThreadWithProject[],
): ThreadWithProject[] => {
  return [...threadsList].sort((a, b) => {
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });
};

export type GroupedThreads = {
  [dateGroup: string]: ThreadWithProject[];
};

export const groupThreadsByDate = (
  threadsList: ThreadWithProject[]
): GroupedThreads => {
  const sortedThreads = sortThreads(threadsList);
  const grouped: GroupedThreads = {};
  const now = new Date();
  
  // Get start of today (midnight)
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  
  sortedThreads.forEach(thread => {
    const threadDate = new Date(thread.updatedAt);
    
    // Get start of thread date (midnight)
    const startOfThreadDate = new Date(threadDate);
    startOfThreadDate.setHours(0, 0, 0, 0);
    
    // Calculate difference in calendar days, not 24-hour periods
    const diffInDays = Math.floor((startOfToday.getTime() - startOfThreadDate.getTime()) / (1000 * 60 * 60 * 24));
    
    let dateGroup: string;
    
    if (diffInDays === 0) {
      dateGroup = 'Today';
    } else if (diffInDays === 1) {
      dateGroup = 'Yesterday';
    } else if (diffInDays <= 7) {
      dateGroup = 'This Week';
    } else if (diffInDays <= 30) {
      dateGroup = 'This Month';
    } else if (diffInDays <= 90) {
      dateGroup = 'Last 3 Months';
    } else {
      dateGroup = 'Older';
    }
    
    if (!grouped[dateGroup]) {
      grouped[dateGroup] = [];
    }
    grouped[dateGroup].push(thread);
  });
  
  return grouped;
};
