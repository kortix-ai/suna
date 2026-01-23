'use client';

import React, { useState, useMemo, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { KortixLoader } from '@/components/ui/kortix-loader';
import { useThreads } from '@/hooks/threads/use-threads';
import { FileBrowserView } from '@/components/thread/kortix-computer/FileBrowserView';
import { FileViewerView } from '@/components/thread/kortix-computer/FileViewerView';
import { SandboxStatusView } from '@/components/thread/kortix-computer/components/SandboxStatusView';
import { useKortixComputerStore } from '@/stores/kortix-computer-store';
import { useSandboxStatusWithAutoStart, isSandboxUsable } from '@/hooks/files/use-sandbox-details';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { HardDrive, MessageSquare } from 'lucide-react';

export default function FilesPage() {
  const router = useRouter();
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  
  // Get store state - exactly like KortixComputer
  const { navigateToPath, filesSubView, selectedFilePath } = useKortixComputerStore();

  // Fetch threads to build project list
  const { data: threadsResponse, isLoading: isThreadsLoading } = useThreads({
    page: 1,
    limit: 200,
  });

  // Build list of unique projects with sandboxes (keep full project data)
  const projectsWithSandboxes = useMemo(() => {
    if (!threadsResponse?.threads) return [];
    
    const projectMap = new Map<string, { 
      projectId: string; 
      projectName: string; 
      sandboxId: string; 
      threadId: string; 
      updatedAt: string;
      project: typeof threadsResponse.threads[0]['project'];
    }>();
    
    for (const thread of threadsResponse.threads) {
      if (thread.project_id && thread.project?.sandbox?.id) {
        const existing = projectMap.get(thread.project_id);
        if (!existing || new Date(thread.updated_at) > new Date(existing.updatedAt)) {
          projectMap.set(thread.project_id, {
            projectId: thread.project_id,
            projectName: thread.project?.name || thread.metadata?.title || `Project ${thread.project_id.slice(0, 8)}`,
            sandboxId: thread.project.sandbox.id,
            threadId: thread.thread_id,
            updatedAt: thread.updated_at,
            project: thread.project,
          });
        }
      }
    }
    
    return Array.from(projectMap.values()).sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );
  }, [threadsResponse]);

  // Auto-select first project
  const projectId = selectedProjectId || projectsWithSandboxes[0]?.projectId || '';
  const selectedProject = projectsWithSandboxes.find(p => p.projectId === projectId);
  const sandboxId = selectedProject?.sandboxId || '';
  const threadId = selectedProject?.threadId;
  const project = selectedProject?.project;

  // Get sandbox status - exactly like KortixComputer
  const { data: sandboxStatus } = useSandboxStatusWithAutoStart(projectId || undefined);
  const isSandboxLive = sandboxStatus?.status ? isSandboxUsable(sandboxStatus.status) : false;

  // Reset path when project changes
  useEffect(() => {
    navigateToPath('/workspace');
  }, [projectId, navigateToPath]);

  const handleNavigateToThread = React.useCallback(() => {
    if (threadId && projectId) {
      router.push(`/projects/${projectId}/thread/${threadId}`);
    } else {
      router.push('/dashboard');
    }
  }, [router, projectId, threadId]);

  // Loading
  if (isThreadsLoading) {
    return (
      <div className="flex items-center justify-center h-[100dvh] bg-background">
        <KortixLoader size="medium" />
      </div>
    );
  }

  // No projects
  if (projectsWithSandboxes.length === 0) {
    return (
      <div className="flex items-center justify-center h-[100dvh] bg-background">
        <div className="text-center space-y-4">
          <HardDrive className="h-12 w-12 mx-auto text-muted-foreground" />
          <h2 className="text-lg font-semibold">No Computers Yet</h2>
          <p className="text-sm text-muted-foreground max-w-xs">
            Start a conversation to create your first computer.
          </p>
          <Button onClick={() => router.push('/dashboard')}>Start a Chat</Button>
        </div>
      </div>
    );
  }

  // Project selector
  const projectSelector = (
    <div className="flex items-center gap-2">
      <Select value={projectId} onValueChange={setSelectedProjectId}>
        <SelectTrigger className="w-[200px] h-9">
          <HardDrive className="h-4 w-4 mr-2 text-muted-foreground" />
          <SelectValue placeholder="Select computer" />
        </SelectTrigger>
        <SelectContent>
          {projectsWithSandboxes.map((p) => (
            <SelectItem key={p.projectId} value={p.projectId}>
              {p.projectName}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {threadId && (
        <Button variant="ghost" size="icon" onClick={handleNavigateToThread}>
          <MessageSquare className="h-4 w-4" />
        </Button>
      )}
    </div>
  );

  // Render IDENTICAL to KortixComputer's renderFilesView
  const renderFilesView = () => {
    // Show status view if sandbox is not LIVE - identical to KortixComputer
    if (!isSandboxLive) {
      return <SandboxStatusView projectId={projectId} />;
    }

    // Show file viewer if viewing a specific file - identical to KortixComputer
    if (filesSubView === 'viewer' && selectedFilePath) {
      return (
        <FileViewerView
          sandboxId={sandboxId}
          filePath={selectedFilePath}
          project={project}
          projectId={projectId}
        />
      );
    }

    // Show file browser - identical to KortixComputer
    return (
      <FileBrowserView
        sandboxId={sandboxId}
        project={project}
        projectId={projectId}
        variant="inline-library"
      />
    );
  };

  return (
    <div className="h-[100dvh] bg-background flex flex-col">
      {/* Project selector header - only difference from KortixComputer */}
      <div className="px-4 py-3 border-b flex items-center justify-between flex-shrink-0">
        <h1 className="text-lg font-semibold">Files</h1>
        {projectSelector}
      </div>
      {/* Content - IDENTICAL to KortixComputer */}
      <div className="flex-1 overflow-hidden">
        {renderFilesView()}
      </div>
    </div>
  );
}
