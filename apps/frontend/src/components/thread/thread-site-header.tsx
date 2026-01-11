'use client';

import { Button } from "@/components/ui/button"
import { Upload, PanelRightOpen, PanelRightClose, Copy, Check } from "lucide-react"
import { toast } from "@/lib/toast"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { useState } from "react"
import { useIsMobile } from "@/hooks/utils"
import { cn } from "@/lib/utils"
import { SharePopover } from "@/components/sidebar/share-modal"
import { ModeIndicator } from "@/components/thread/mode-indicator"

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
  const [copied, setCopied] = useState(false);
  const isMobile = useIsMobile() || isMobileView

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

  return (
    <header className={cn(
      "bg-background sticky top-0 flex shrink-0 gap-2 z-20 w-full pt-4",
      isMobile && "px-2"
    )}>
      <div className="flex flex-1 items-center h-[32px] gap-2 px-3 min-w-0">
        {variant === 'shared' ? (
          <div className="text-base font-medium text-muted-foreground flex items-center gap-2 min-w-0">
            <span className="truncate">{projectName}</span>
            <span className="text-xs bg-primary text-primary-foreground px-2 py-0.5 rounded-full shrink-0">
              Shared
            </span>
          </div>
        ) : (
          <ModeIndicator />
        )}
      </div>

      <div className="flex items-center h-[32px] gap-1 pr-4">
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
