'use client';

import React, { useMemo, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { KortixLoader } from '@/components/ui/kortix-loader';
import { useProjectQuery } from '@/hooks/threads/use-project';
import { useThreads } from '@/hooks/threads/use-threads';
import { usePresentationViewerStore, PresentationViewerWrapper } from '@/stores/presentation-viewer-store';
import { useFileViewerStore, FileViewerWrapper } from '@/stores/file-viewer-store';
import { FileBrowserView } from '@/components/thread/kortix-computer/FileBrowserView';
import { useKortixComputerStore } from '@/stores/kortix-computer-store';

export default function LibraryBrowserPage({
  params,
}: {
  params: Promise<{
    projectId: string;
  }>;
}) {
  const unwrappedParams = React.use(params);
  const { projectId } = unwrappedParams;
  const router = useRouter();

  // Reset the currentPath in the store when mounting the library page
  const { navigateToPath } = useKortixComputerStore();
  useEffect(() => {
    // Start at workspace root when opening library
    navigateToPath('/workspace');
  }, [navigateToPath]);

  // Fetch project data - force refetch to ensure we have sandbox data
  const { data: project, isLoading: isProjectLoading } = useProjectQuery(projectId, {
    refetchOnMount: 'always',
    staleTime: 0,
  });
  
  // Also fetch threads list as fallback source for sandbox data (increased limit)
  const { data: threadsResponse, isLoading: isThreadsLoading } = useThreads({
    page: 1,
    limit: 200,
  });

  // Find sandbox ID from project or threads
  const sandboxId = useMemo(() => {
    // First try project query - this is the primary source
    if (project?.sandbox?.id) {
      return project.sandbox.id;
    }
    
    // Fallback: find thread with this project_id in the threads list
    const thread = threadsResponse?.threads?.find(t => t.project_id === projectId);
    if (thread?.project?.sandbox?.id) {
      return thread.project.sandbox.id;
    }
    
    return null;
  }, [project, threadsResponse, projectId]);

  // Get thread ID for navigation to chat
  const threadId = useMemo(() => {
    const thread = threadsResponse?.threads?.find(t => t.project_id === projectId);
    return thread?.thread_id;
  }, [threadsResponse, projectId]);

  const isLoading = isProjectLoading || isThreadsLoading;

  // Navigate to thread handler
  const handleNavigateToThread = React.useCallback(() => {
    if (threadId) {
      router.push(`/projects/${projectId}/thread/${threadId}`);
    } else {
      router.push('/dashboard');
    }
  }, [router, projectId, threadId]);

  // Show loader while fetching project/thread data
  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-screen bg-background">
        <KortixLoader size="medium" />
      </div>
    );
  }

  return (
    <>
      <PresentationViewerWrapper />
      <FileViewerWrapper />
      <FileBrowserView
        sandboxId={sandboxId || ''}
        project={project || undefined}
        projectId={projectId}
        variant="library"
        onNavigateToThread={handleNavigateToThread}
      />
    </>
  );
}
