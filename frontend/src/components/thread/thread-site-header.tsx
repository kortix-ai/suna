'use client';

import { Button } from "@/components/ui/button"
import { FolderOpen, ExternalLink, Monitor } from "lucide-react"
import { usePathname } from "next/navigation"
import { toast } from "sonner"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { useState, useRef, KeyboardEvent } from "react"
import { Input } from "@/components/ui/input"
import { useUpdateProject } from "@/hooks/react-query"
import { Skeleton } from "@/components/ui/skeleton"
import { useIsMobile } from "@/hooks/use-mobile"
import { cn } from "@/lib/utils"
import { ShareModal } from "@/components/sidebar/share-modal"
import { useQueryClient } from "@tanstack/react-query";
import { projectKeys } from "@/hooks/react-query/sidebar/keys";
import { threadKeys } from "@/hooks/react-query/threads/keys";
import { useFeatureFlags } from "@/lib/feature-flags";

interface ThreadSiteHeaderProps {
  threadId: string;
  projectId: string;
  projectName: string;
  onViewFiles: (filePath?: string, filePathList?: string[]) => void;
  onToggleSidePanel: () => void;
  onProjectRenamed?: (newName: string) => void;
  isMobileView?: boolean;
  debugMode?: boolean;
}

export function SiteHeader({
  threadId,
  projectId,
  projectName,
  onViewFiles,
  onToggleSidePanel,
  onProjectRenamed,
  isMobileView,
  debugMode,
}: ThreadSiteHeaderProps) {
  const pathname = usePathname()
  const [isEditing, setIsEditing] = useState(false)
  const [editName, setEditName] = useState(projectName)
  const inputRef = useRef<HTMLInputElement>(null)
  const [showShareModal, setShowShareModal] = useState(false);
  const [showKnowledgeBase, setShowKnowledgeBase] = useState(false);
  const queryClient = useQueryClient();
  const { flags, loading: flagsLoading } = useFeatureFlags(['knowledge_base']);
  const knowledgeBaseEnabled = flags.knowledge_base;

  const isMobile = useIsMobile() || isMobileView
  const updateProjectMutation = useUpdateProject()

  const openShareModal = () => {
    setShowShareModal(true)
  }

  const openKnowledgeBase = () => {
    setShowKnowledgeBase(true)
  }

  const startEditing = () => {
    setEditName(projectName);
    setIsEditing(true);
    setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);
  };

  const cancelEditing = () => {
    setIsEditing(false);
    setEditName(projectName);
  };

  const saveNewName = async () => {
    if (editName.trim() === '') {
      setEditName(projectName);
      setIsEditing(false);
      return;
    }

    if (editName !== projectName) {
      try {
        if (!projectId) {
          toast.error('Cannot rename: Project ID is missing');
          setEditName(projectName);
          setIsEditing(false);
          return;
        }

        const updatedProject = await updateProjectMutation.mutateAsync({
          projectId,
          data: { name: editName }
        })
        if (updatedProject) {
          onProjectRenamed?.(editName);
          queryClient.invalidateQueries({ queryKey: threadKeys.project(projectId) });
        } else {
          throw new Error('Failed to update project');
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : 'Failed to rename project';
        console.error('Failed to rename project:', errorMessage);
        toast.error(errorMessage);
        setEditName(projectName);
      }
    }

    setIsEditing(false)
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      saveNewName();
    } else if (e.key === 'Escape') {
      cancelEditing();
    }
  };

  return (
    <>
      <header className={cn(
        "bg-background sticky top-0 flex h-14 shrink-0 items-center gap-2 z-20 w-full",
        isMobile && "px-2"
      )}>


        <div className="flex flex-1 items-center gap-2 px-3">
          {isEditing ? (
            <Input
              ref={inputRef}
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              onKeyDown={handleKeyDown}
              onBlur={saveNewName}
              className="h-8 w-auto min-w-[180px] text-base font-medium"
              maxLength={50}
            />
          ) : !projectName || projectName === 'Project' ? (
            <Skeleton className="h-5 w-32" />
          ) : (
            <div
              className="text-base font-medium text-muted-foreground hover:text-foreground cursor-pointer flex items-center"
              onClick={startEditing}
              title="Click to rename project"
            >
              {projectName}
            </div>
          )}
        </div>

        <div className="flex items-center gap-1 pr-4">
          {/* Debug mode indicator */}
          {debugMode && (
            <div className="bg-amber-500 text-black text-xs px-2 py-0.5 rounded-md mr-2">
              Debug
            </div>
          )}

          {/* Show all buttons on both mobile and desktop - responsive tooltips */}
          <TooltipProvider>

          <Button
              variant="ghost"
              onClick={openShareModal}
              className="h-9 px-3 cursor-pointer gap-2"
            >
              <ExternalLink className="h-4 w-4" />
              <span>Share</span>
            </Button>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => {
                    console.log('View Files button clicked');
                    onViewFiles();
                  }}
                  className="h-9 w-9 cursor-pointer"
                >
                  <FolderOpen className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side={isMobile ? "bottom" : "bottom"}>
                <p>View Files in Task</p>
              </TooltipContent>
            </Tooltip>



            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={onToggleSidePanel}
                  className="h-9 w-9 cursor-pointer"
                >
                  <Monitor className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side={isMobile ? "bottom" : "bottom"}>
                <p>Toggle Computer Preview (CMD+I)</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      </header>
      <ShareModal
        isOpen={showShareModal}
        onClose={() => setShowShareModal(false)}
        threadId={threadId}
        projectId={projectId}
      />
      
    </>
  )
} 