"use client"

import { useEffect, useState } from "react"
import {
  ArrowUpRight,
  Link as LinkIcon,
  MoreHorizontal,
  Trash2,
  StarOff,
  Plus,
  MessagesSquare,
} from "lucide-react"
import { toast } from "sonner"

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from "@/components/ui/tooltip"
import { getProjects, getThreads } from "@/lib/api"
import Link from "next/link"

export function NavAgents() {
  const { isMobile, state } = useSidebar()
  const [agents, setAgents] = useState<{name: string, url: string}[]>([])
  const [isLoading, setIsLoading] = useState(true)

  // Load agents dynamically from the API
  useEffect(() => {
    async function loadAgents() {
      try {
        const projectsData = await getProjects()
        const agentsList = []
        const seenThreadIds = new Set() // Track unique thread IDs
        
        for (const project of projectsData) {
          const threads = await getThreads(project.id)
          if (threads && threads.length > 0) {
            // For each thread in the project, create an agent entry
            for (const thread of threads) {
              // Only add if we haven't seen this thread ID before
              if (!seenThreadIds.has(thread.thread_id)) {
                seenThreadIds.add(thread.thread_id)
                agentsList.push({
                  name: `${project.name} - ${thread.thread_id.slice(0, 4)}`,
                  url: `/dashboard/agents/${thread.thread_id}`
                })
              }
            }
          }
        }
        
        setAgents(agentsList)
      } catch (err) {
        console.error("Error loading agents for sidebar:", err)
      } finally {
        setIsLoading(false)
      }
    }
    
    loadAgents()
  }, [])

  return (
    <SidebarGroup>
      <div className="flex justify-between items-center">
        <SidebarGroupLabel>Agents</SidebarGroupLabel>
        <Tooltip>
          <TooltipTrigger asChild>
            <Link 
              href="/dashboard" 
              className="text-muted-foreground hover:text-foreground h-8 w-8 flex items-center justify-center rounded-md"
            >
              <Plus className="h-4 w-4" />
              <span className="sr-only">New Agent</span>
            </Link>
          </TooltipTrigger>
          <TooltipContent>New Agent</TooltipContent>
        </Tooltip>
      </div>

      <SidebarMenu className="overflow-y-auto max-h-[calc(100vh-200px)]">
        {isLoading ? (
          // Show skeleton loaders while loading
          Array.from({length: 3}).map((_, index) => (
            <SidebarMenuItem key={`skeleton-${index}`}>
              <SidebarMenuButton>
                <div className="h-4 w-4 bg-sidebar-foreground/10 rounded-md animate-pulse"></div>
                <div className="h-3 bg-sidebar-foreground/10 rounded w-3/4 animate-pulse"></div>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))
        ) : agents.length > 0 ? (
          // Show all agents
          <>
            {agents.map((item, index) => (
              <SidebarMenuItem key={`agent-${index}`}>
                {state === "collapsed" ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <SidebarMenuButton asChild>
                        <Link href={item.url}>
                          <MessagesSquare className="h-4 w-4" />
                          <span>{item.name}</span>
                        </Link>
                      </SidebarMenuButton>
                    </TooltipTrigger>
                    <TooltipContent>{item.name}</TooltipContent>
                  </Tooltip>
                ) : (
                  <SidebarMenuButton asChild>
                    <Link href={item.url}>
                      <MessagesSquare className="h-4 w-4" />
                      <span>{item.name}</span>
                    </Link>
                  </SidebarMenuButton>
                )}
                {state !== "collapsed" && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <SidebarMenuAction showOnHover>
                        <MoreHorizontal />
                        <span className="sr-only">More</span>
                      </SidebarMenuAction>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent
                      className="w-56 rounded-lg"
                      side={isMobile ? "bottom" : "right"}
                      align={isMobile ? "end" : "start"}
                    >
                      <DropdownMenuItem onClick={() => {
                        navigator.clipboard.writeText(window.location.origin + item.url)
                        toast.success("Link copied to clipboard")
                      }}>
                        <LinkIcon className="text-muted-foreground" />
                        <span>Copy Link</span>
                      </DropdownMenuItem>
                      <DropdownMenuItem asChild>
                        <a href={item.url} target="_blank" rel="noopener noreferrer">
                          <ArrowUpRight className="text-muted-foreground" />
                          <span>Open in New Tab</span>
                        </a>
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem>
                        <Trash2 className="text-muted-foreground" />
                        <span>Delete</span>
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </SidebarMenuItem>
            ))}
          </>
        ) : (
          // Empty state
          <SidebarMenuItem>
            <SidebarMenuButton className="text-sidebar-foreground/70">
              <MessagesSquare className="h-4 w-4" />
              <span>No agents yet</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        )}
      </SidebarMenu>
    </SidebarGroup>
  )
}
