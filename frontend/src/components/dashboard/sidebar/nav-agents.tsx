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

// Define a type to handle potential database schema/API response differences
type ProjectResponse = {
  id: string;
  project_id?: string;
  name: string;
  [key: string]: any; // Allow other properties
}

export function NavAgents() {
  const { isMobile, state } = useSidebar()
  const [agents, setAgents] = useState<{name: string, url: string}[]>([])
  const [isLoading, setIsLoading] = useState(true)

  // Load agents dynamically from the API
  useEffect(() => {
    async function loadAgents() {
      try {
        // Get all projects
        const projectsData = await getProjects() as ProjectResponse[]
        console.log("Projects data:", projectsData)
        
        const agentsList = []
        
        // Get all threads at once
        const allThreads = await getThreads() 
        console.log("All threads:", allThreads)
        
        // For each project, find its matching threads
        for (const project of projectsData) {
          console.log("Processing project:", project)
          
          // Get the project ID (handle potential different field names)
          const projectId = project.id || project.project_id
          
          // Match threads that belong to this project
          const projectThreads = allThreads.filter(thread => 
            thread.project_id === projectId
          )
          
          console.log(`Found ${projectThreads.length} threads for project ${project.name}:`, projectThreads)
          
          if (projectThreads.length > 0) {
            // For each thread in this project, create an agent entry
            for (const thread of projectThreads) {
              agentsList.push({
                name: project.name || 'Unnamed Project',
                url: `/dashboard/agents/${thread.thread_id}`
              })
              console.log(`Added agent with name: ${project.name} and thread: ${thread.thread_id}`)
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
