'use client';

import { Button } from "@/components/ui/button"
import { FolderOpen, Upload, PanelRightOpen, PanelRightClose, Copy, Check } from "lucide-react"
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
import { useUpdateProject } from "@/hooks/threads/use-project";
import { Skeleton } from "@/components/ui/skeleton"
import { useIsMobile } from "@/hooks/utils"
import { cn } from "@/lib/utils"
import { SharePopover } from "@/components/sidebar/share-modal"
import { useQueryClient } from "@tanstack/react-query";
import { projectKeys } from "@/hooks/threads/keys";
import { threadKeys } from "@/hooks/threads/keys";

interface ThreadSiteHeaderProps {
  threadId?: string;
  projectId?: string;
  projectName: string;
  onViewFiles: () => void;
  onToggleSidePanel: () => void;
  isSidePanelOpen?: boolean;
  onProjectRenamed?: (newName: string) => void;
  isMobileView?: boolean;
  variant?: 'default' | 'shared';
}

export function SiteHeader({
  threadId,
  projectId,
  projectName,
  onViewFiles,
  onToggleSidePanel,
  isSidePanelOpen = false,
  onProjectRenamed,
  isMobileView,
  variant = 'default',
}: ThreadSiteHeaderProps) {
  const pathname = usePathname()
  const [isEditing, setIsEditing] = useState(false)
  const [editName, setEditName] = useState(projectName)
  const inputRef = useRef<HTMLInputElement>(null)
  const isSharedVariant = variant === 'shared'
  const [showKnowledgeBase, setShowKnowledgeBase] = useState(false);
  const [copied, setCopied] = useState(false);
  const queryClient = useQueryClient();

  const isMobile = useIsMobile() || isMobileView
  const updateProjectMutation = useUpdateProject()

  const openKnowledgeBase = () => {
    setShowKnowledgeBase(true)
  }

  const copyShareLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      toast.success("Share link copied to clipboard!");
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      toast.error("Failed to copy link");
    }
  };

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
    <header className={cn(
      "bg-background sticky top-0 flex h-14 shrink-0 items-center gap-2 z-20 w-full",
      isMobile && "px-2"
    )}>
      <div className="flex flex-1 items-center gap-2 px-3 min-w-0">
        {variant === 'shared' ? (
          <div className="text-base font-medium text-muted-foreground flex items-center gap-2 min-w-0">
            <span className="truncate">{projectName}</span>
            <span className="text-xs bg-primary text-primary-foreground px-2 py-0.5 rounded-full shrink-0">
              Shared
            </span>
          </div>
        ) : isEditing ? (
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
            className={cn(
              "text-base font-medium text-muted-foreground truncate",
              !isSharedVariant && "hover:text-foreground cursor-pointer"
            )}
            onClick={isSharedVariant ? undefined : startEditing}
            title={isSharedVariant ? projectName : `Click to rename project: ${projectName}`}
          >
            {projectName}
          </div>
        )}
      </div>

      <div className="flex items-center gap-1 pr-4">
        <TooltipProvider>
          {variant === 'shared' ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  onClick={copyShareLink}
                  className="h-9 px-3 cursor-pointer gap-2"
                >
                  {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  <span>{copied ? 'Copied!' : 'Copy Link'}</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                <p>Copy share link</p>
              </TooltipContent>
            </Tooltip>
          ) : threadId && projectId ? (
            <SharePopover threadId={threadId} projectId={projectId}>
              <Button
                variant="ghost"
                className="h-9 px-3 cursor-pointer gap-2"
              >
                <Upload className="h-4 w-4" />
                <span>Share</span>
              </Button>
            </SharePopover>
          ) : null}

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => onViewFiles()}
                className="h-9 w-9 cursor-pointer"
              >
                <FolderOpen className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
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
                {isSidePanelOpen ? (
                  <PanelRightClose className="h-4 w-4" />
                ) : (
                  <PanelRightOpen className="h-4 w-4" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              <p>{isSidePanelOpen ? 'Close' : 'Open'} Kortix Computer (CMD+I)</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
    </header>
  )
}
