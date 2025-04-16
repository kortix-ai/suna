"use client"

import { Button } from "@/components/ui/button"
import { Copy, File, PanelRightOpen, Check, X } from "lucide-react"
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
import { updateProject } from "@/lib/api"

interface ThreadSiteHeaderProps {
  threadId: string
  projectId: string
  projectName: string
  onViewFiles: () => void
  onToggleSidePanel: () => void
  onProjectRenamed?: (newName: string) => void
}

export function SiteHeader({ 
  threadId, 
  projectId,
  projectName, 
  onViewFiles, 
  onToggleSidePanel,
  onProjectRenamed
}: ThreadSiteHeaderProps) {
  const pathname = usePathname()
  const [isEditing, setIsEditing] = useState(false)
  const [editName, setEditName] = useState(projectName)
  const inputRef = useRef<HTMLInputElement>(null)
  
  const copyCurrentUrl = () => {
    const url = window.location.origin + pathname
    navigator.clipboard.writeText(url)
    toast.success("URL copied to clipboard")
  }

  const startEditing = () => {
    setEditName(projectName)
    setIsEditing(true)
    setTimeout(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    }, 0)
  }

  const cancelEditing = () => {
    setIsEditing(false)
    setEditName(projectName)
  }

  const saveNewName = async () => {
    if (editName.trim() === "") {
      setEditName(projectName)
      setIsEditing(false)
      return
    }
    
    if (editName !== projectName) {
      try {
        await updateProject(projectId, { name: editName })
        onProjectRenamed?.(editName)
        toast.success("Project renamed successfully")
      } catch (error) {
        console.error("Failed to rename project:", error)
        toast.error("Failed to rename project")
        setEditName(projectName)
      }
    }
    
    setIsEditing(false)
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      saveNewName()
    } else if (e.key === "Escape") {
      cancelEditing()
    }
  }

  return (
    <header className="bg-background sticky top-0 flex h-14 shrink-0 items-center gap-2 z-20 border-b w-full">
      <div className="flex flex-1 items-center gap-2 px-3">
        {isEditing ? (
          <div className="flex items-center gap-1">
            <Input
              ref={inputRef}
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              onKeyDown={handleKeyDown}
              onBlur={saveNewName}
              className="h-7 w-auto min-w-[180px] text-sm font-medium"
              maxLength={50}
            />
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={saveNewName}
            >
              <Check className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={cancelEditing}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        ) : (
          <div 
            className="text-sm font-medium tracking-wide uppercase text-muted-foreground hover:text-foreground cursor-pointer flex items-center"
            onClick={startEditing}
            title="Click to rename project"
          >
            {projectName}
          </div>
        )}
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