"use client"

import { useEffect, useState } from "react"
import {
  ArrowUpRight,
  Link as LinkIcon,
  MoreHorizontal,
  Trash2,
  StarOff,
  Plus,
} from "lucide-react"

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
import { getProjects, getThreads } from "@/lib/api"
import Link from "next/link"

export function NavAgents() {
  const { isMobile } = useSidebar()
  const [agents, setAgents] = useState<{name: string, url: string}[]>([])
  const [isLoading, setIsLoading] = useState(true)

  // Load agents dynamically from the API
  useEffect(() => {
    async function loadAgents() {
      try {
        const projectsData = await getProjects()
        const agentsList = []
        
        for (const project of projectsData) {
          const threads = await getThreads(project.id)
          if (threads && threads.length > 0) {
            // For each thread in the project, create an agent entry
            for (const thread of threads) {
              agentsList.push({
                name: project.name,
                url: `/dashboard/agents/${thread.thread_id}`
              })
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

  // Get only the latest 20 agents for the sidebar
  const recentAgents = agents.slice(0, 20)

  return (
    <SidebarGroup className="group-data-[collapsible=icon]:hidden">
      <div className="flex justify-between items-center">
        <SidebarGroupLabel>Agents</SidebarGroupLabel>
        <Link 
          href="/dashboard/agents/new" 
          className="text-muted-foreground hover:text-foreground h-8 w-8 flex items-center justify-center rounded-md"
          title="New Agent"
        >
          <Plus className="h-4 w-4" />
          <span className="sr-only">New Agent</span>
        </Link>
      </div>

      <SidebarMenu>
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
        ) : recentAgents.length > 0 ? (
          // Show agents
          <>
            {recentAgents.map((item, index) => (
              <SidebarMenuItem key={`agent-${index}`}>
                <SidebarMenuButton asChild>
                  <Link href={item.url} title={item.name}>
                    <span>{item.name}</span>
                  </Link>
                </SidebarMenuButton>
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
                    <DropdownMenuItem>
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
              </SidebarMenuItem>
            ))}
            
            {agents.length > 20 && (
              <SidebarMenuItem>
                <SidebarMenuButton asChild className="text-sidebar-foreground/70">
                  <Link href="/dashboard/agents">
                    <MoreHorizontal />
                    <span>See all agents</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            )}
          </>
        ) : (
          // Empty state
          <SidebarMenuItem>
            <SidebarMenuButton className="text-sidebar-foreground/70">
              <span>No agents yet</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        )}
      </SidebarMenu>
    </SidebarGroup>
  )
}
