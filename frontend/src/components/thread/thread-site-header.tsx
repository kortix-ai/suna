"use client"

import { Button } from "@/components/ui/button"
import { Copy, File, PanelRightOpen } from "lucide-react"
import { usePathname } from "next/navigation"
import { toast } from "sonner"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"

interface ThreadSiteHeaderProps {
  threadId: string
  onViewFiles: () => void
  onToggleSidePanel: () => void
}

export function SiteHeader({ threadId, onViewFiles, onToggleSidePanel }: ThreadSiteHeaderProps) {
  const pathname = usePathname()
  
  const copyCurrentUrl = () => {
    const url = window.location.origin + pathname
    navigator.clipboard.writeText(url)
    toast.success("URL copied to clipboard")
  }

  return (
    <header className="bg-background sticky top-0 flex h-14 shrink-0 items-center gap-2 z-20 border-b w-full">
      <div className="flex flex-1 items-center gap-2 px-3">
        {/* SidebarTrigger will be moved to SidebarLeft */}
      </div>
      
      <div className="absolute left-1/2 -translate-x-1/2 text-sm font-medium tracking-wide uppercase text-muted-foreground">
        Thread {threadId}
      </div>
      
      <div className="flex items-center gap-1 pr-4">
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={onViewFiles}
                className="h-9 w-9"
              >
                <File className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>View Files in Task</p>
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={copyCurrentUrl}
                className="h-9 w-9"
              >
                <Copy className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>Copy URL</p>
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={onToggleSidePanel}
                className="h-9 w-9"
              >
                <PanelRightOpen className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>Toggle Tool Details</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
    </header>
  )
} 