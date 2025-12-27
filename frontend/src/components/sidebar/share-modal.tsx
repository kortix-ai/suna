"use client"

import { useState, useEffect } from "react"
import { Popover, PopoverContent, PopoverTrigger, PopoverAnchor } from "@/components/ui/popover"
import { Switch } from "@/components/ui/switch"
import { Copy, Check, Globe, ExternalLink, Lock } from "lucide-react"
import { toast } from "sonner"
import { useThreadQuery, useUpdateThreadMutation } from "@/hooks/threads/use-threads"
import { Skeleton } from "../ui/skeleton"
import { cn } from "@/lib/utils"

interface SharePopoverProps {
  threadId?: string
  projectId?: string
  children?: React.ReactNode
  side?: "top" | "right" | "bottom" | "left"
  align?: "start" | "center" | "end"
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

const LoadingSkeleton = () => (
  <div className="space-y-3">
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-2.5">
        <Skeleton className="h-8 w-8 rounded-full" />
        <div className="space-y-1">
          <Skeleton className="h-3.5 w-16" />
          <Skeleton className="h-2.5 w-24" />
        </div>
      </div>
      <Skeleton className="h-4 w-8 rounded-full" />
    </div>
  </div>
)

// Social icons
const XIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" className="h-3 w-3" fill="currentColor">
    <path d="M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z" />
  </svg>
)

const LinkedInIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" className="h-3 w-3" fill="currentColor">
    <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.064 2.064 0 112.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" />
  </svg>
)

// Shared content component
function SharePopoverContent({ 
  threadId, 
  isOpen 
}: { 
  threadId?: string
  isOpen: boolean 
}) {
  const [copied, setCopied] = useState(false)

  const updateThreadMutation = useUpdateThreadMutation()
  const { data: threadData, isLoading, refetch } = useThreadQuery(threadId || "")

  const isPublic = Boolean(threadData?.is_public)
  
  const shareLink = threadId 
    ? `${process.env.NEXT_PUBLIC_URL || (typeof window !== 'undefined' ? window.location.origin : '')}/share/${threadId}`
    : ""

  // Reset copied when popover closes
  useEffect(() => {
    if (!isOpen) setCopied(false)
  }, [isOpen])

  const handleToggle = async (checked: boolean) => {
    if (!threadId) return
    try {
      await updateThreadMutation.mutateAsync({
        threadId,
        data: { is_public: checked },
      })
      await refetch()
      toast.success(checked ? "Link enabled" : "Link disabled")
    } catch (error) {
      console.error("Error:", error)
      toast.error("Failed to update")
    }
  }

  const handleCopy = async () => {
    if (!shareLink || copied) return
    try {
      await navigator.clipboard.writeText(shareLink)
      setCopied(true)
      toast.success("Copied")
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.error("Failed to copy")
    }
  }

  const handleOpen = () => window.open(shareLink, "_blank", "noopener,noreferrer")
  
  const handleShareX = () => {
    const text = encodeURIComponent("Check out this conversation")
    const url = encodeURIComponent(shareLink)
    window.open(`https://twitter.com/intent/tweet?text=${text}&url=${url}`, "_blank")
  }

  const handleShareLinkedIn = () => {
    const url = encodeURIComponent(shareLink)
    window.open(`https://www.linkedin.com/sharing/share-offsite/?url=${url}`, "_blank")
  }

  if (isLoading) {
    return (
      <div className="p-4">
        <LoadingSkeleton />
      </div>
    )
  }

  return (
    <div className="p-3 space-y-3">
      {/* Toggle Row */}
      <button
        onClick={() => handleToggle(!isPublic)}
        disabled={updateThreadMutation.isPending}
        className={cn(
          "w-full flex items-center justify-between p-2.5 rounded-xl transition-all",
          "hover:bg-muted/50 active:scale-[0.98]",
          updateThreadMutation.isPending && "opacity-60 pointer-events-none"
        )}
      >
        <div className="flex items-center gap-2.5">
          <div className={cn(
            "flex items-center justify-center h-8 w-8 rounded-full transition-all duration-200",
            isPublic 
              ? "bg-foreground text-background" 
              : "bg-muted text-muted-foreground"
          )}>
            {isPublic ? <Globe className="h-3.5 w-3.5" /> : <Lock className="h-3.5 w-3.5" />}
          </div>
          <div className="text-left">
            <p className="text-sm font-medium leading-none">
              {isPublic ? "Public" : "Private"}
            </p>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              {isPublic ? "Anyone with link" : "Only you"}
            </p>
          </div>
        </div>
        <Switch
          checked={isPublic}
          onCheckedChange={handleToggle}
          disabled={updateThreadMutation.isPending}
          className="pointer-events-none"
        />
      </button>

      {/* Link Actions - Visible when public */}
      {isPublic && (
        <div className="space-y-2 animate-in fade-in-0 slide-in-from-top-1 duration-150">
          {/* Copy URL */}
          <button
            onClick={handleCopy}
            className={cn(
              "w-full flex items-center gap-2 px-3 h-9 rounded-lg transition-all",
              "bg-muted/40 hover:bg-muted/70 active:scale-[0.98]",
              copied && "bg-foreground/5"
            )}
          >
            <span className="flex-1 text-[11px] text-muted-foreground font-mono truncate text-left">
              {shareLink.replace(/^https?:\/\//, '')}
            </span>
            <div className={cn(
              "transition-colors",
              copied ? "text-foreground" : "text-muted-foreground"
            )}>
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            </div>
          </button>

          {/* Actions Row */}
          <div className="flex items-center gap-1.5">
            <button
              onClick={handleOpen}
              className="flex-1 flex items-center justify-center gap-1.5 h-8 rounded-lg text-xs font-medium bg-foreground text-background hover:bg-foreground/90 active:scale-[0.98] transition-all"
            >
              <ExternalLink className="h-3 w-3" />
              Open
            </button>
            <button
              onClick={handleShareX}
              className="flex items-center justify-center h-8 w-8 rounded-lg border border-border hover:bg-muted transition-colors"
            >
              <XIcon />
            </button>
            <button
              onClick={handleShareLinkedIn}
              className="flex items-center justify-center h-8 w-8 rounded-lg border border-border hover:bg-muted transition-colors"
            >
              <LinkedInIcon />
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export function SharePopover({ 
  threadId, 
  projectId, 
  children,
  side = "bottom",
  align = "end",
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange
}: SharePopoverProps) {
  const [internalOpen, setInternalOpen] = useState(false)
  
  // Support both controlled and uncontrolled modes
  const isControlled = controlledOpen !== undefined
  const isOpen = isControlled ? controlledOpen : internalOpen
  const setOpen = isControlled ? (controlledOnOpenChange || (() => {})) : setInternalOpen

  return (
    <Popover open={isOpen} onOpenChange={setOpen}>
      {children ? (
        <PopoverTrigger asChild>
          {children}
        </PopoverTrigger>
      ) : (
        <PopoverAnchor className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2" />
      )}
      <PopoverContent 
        side={children ? side : "bottom"} 
        align={children ? align : "center"} 
        className="w-72 p-0 overflow-hidden"
        sideOffset={8}
      >
        {/* Header */}
        <div className="px-4 py-3 border-b border-border/50">
          <p className="text-sm font-medium">Share</p>
        </div>

        <SharePopoverContent threadId={threadId} isOpen={isOpen} />
      </PopoverContent>
    </Popover>
  )
}
