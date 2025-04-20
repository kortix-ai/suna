"use client"

import { useEffect, useState } from "react"
import {
  ArrowUpRight,
  Link as LinkIcon,
  MoreHorizontal,
  Trash2,
  Plus,
  MessagesSquare,
  Loader2,
} from "lucide-react"
import { toast } from "sonner"
import { usePathname, useRouter } from "next/navigation"

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
  updated_at?: string;
  [key: string]: any; // Allow other properties
}

// Agent type with project ID for easier updating
type Agent = {
  projectId: string;
  threadId: string;
  name: string;
  url: string;
  updatedAt: string; // Store updated_at for consistent sorting
}

export function NavAgents() {
  const { isMobile, state } = useSidebar()
  const [agents, setAgents] = useState<Agent[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [loadingAgentId, setLoadingAgentId] = useState<string | null>(null)
  const pathname = usePathname()
  const router = useRouter()

  // Helper to sort agents by updated_at (most recent first)
  const sortAgents = (agentsList: Agent[]): Agent[] => {
    return [...agentsList].sort((a, b) => {
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });
  };

  // Function to load agents data
  const loadAgents = async (showLoading = true) => {
    try {
      if (showLoading) {
        setIsLoading(true)
      }
      
      // Get all projects
      const projectsData = await getProjects() as ProjectResponse[]
      
      // Get all threads at once
      const allThreads = await getThreads() 
      
      // For each project, find its matching threads
      const agentsList: Agent[] = []
      for (const project of projectsData) {
        // Get the project ID (handle potential different field names)
        const projectId = project.id || project.project_id || ''
        
        // Get the updated_at timestamp (default to current time if not available)
        const updatedAt = project.updated_at || new Date().toISOString()
        
        // Match threads that belong to this project
        const projectThreads = allThreads.filter(thread => 
          thread.project_id === projectId
        )
        
        if (projectThreads.length > 0) {
          // For each thread in this project, create an agent entry
          for (const thread of projectThreads) {
            agentsList.push({
              projectId,
              threadId: thread.thread_id,
              name: project.name || 'Unnamed Project',
              url: `/dashboard/agents/${thread.thread_id}`,
              updatedAt: thread.updated_at || updatedAt // Use thread update time if available
            })
          }
        }
      }
      
      // Set agents, ensuring consistent sort order
      setAgents(sortAgents(agentsList))
    } catch (err) {
      console.error("Error loading agents for sidebar:", err)
    } finally {
      if (showLoading) {
        setIsLoading(false)
      }
    }
  }

  // Load agents dynamically from the API on initial load
  useEffect(() => {
    loadAgents(true)
  }, [])

  // Listen for project-updated events to update the sidebar without full reload
  useEffect(() => {
    const handleProjectUpdate = (event: Event) => {
      const customEvent = event as CustomEvent;
      if (customEvent.detail) {
        const { projectId, updatedData } = customEvent.detail;
        
        // Update just the name for the agents with the matching project ID
        // Don't update the timestamp here to prevent immediate re-sorting
        setAgents(prevAgents => {
          const updatedAgents = prevAgents.map(agent => 
            agent.projectId === projectId 
              ? { 
                  ...agent, 
                  name: updatedData.name,
                  // Keep the original updatedAt timestamp locally
                } 
              : agent
          );
          
          // Return the agents without re-sorting immediately
          return updatedAgents;
        });
        
        // Silently refresh in background to fetch updated timestamp and re-sort
        setTimeout(() => loadAgents(false), 1000);
      }
    }

    // Add event listener
    window.addEventListener('project-updated', handleProjectUpdate as EventListener);
    
    // Cleanup
    return () => {
      window.removeEventListener('project-updated', handleProjectUpdate as EventListener);
    }
  }, []);

  // Reset loading state when navigation completes (pathname changes)
  useEffect(() => {
    setLoadingAgentId(null)
  }, [pathname])

  // Function to handle agent click with loading state
  const handleAgentClick = (e: React.MouseEvent<HTMLAnchorElement>, threadId: string, url: string) => {
    e.preventDefault()
    setLoadingAgentId(threadId)
    router.push(url)
  }

  return (
    <SidebarGroup>
      <div className="flex justify-between items-center">
        <SidebarGroupLabel>Agents</SidebarGroupLabel>
        {state !== "collapsed" ? (
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
        ) : null}
      </div>

      <SidebarMenu className="overflow-y-auto max-h-[calc(100vh-200px)]">
        {state === "collapsed" && (
          <SidebarMenuItem>
            <Tooltip>
              <TooltipTrigger asChild>
                <SidebarMenuButton asChild>
                  <Link href="/dashboard" className="flex items-center">
                    <Plus className="h-4 w-4" />
                    <span>New Agent</span>
                  </Link>
                </SidebarMenuButton>
              </TooltipTrigger>
              <TooltipContent>New Agent</TooltipContent>
            </Tooltip>
          </SidebarMenuItem>
        )}
        
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
            {agents.map((agent, index) => {
              // Check if this agent is currently active
              const isActive = pathname.includes(agent.threadId);
              const isAgentLoading = loadingAgentId === agent.threadId;
              
              return (
                <SidebarMenuItem key={`agent-${agent.threadId}`}>
                  {state === "collapsed" ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <SidebarMenuButton asChild className={isActive ? "bg-accent text-accent-foreground" : ""}>
                          <Link href={agent.url} onClick={(e) => handleAgentClick(e, agent.threadId, agent.url)}>
                            {isAgentLoading ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <MessagesSquare className="h-4 w-4" />
                            )}
                            <span>{agent.name}</span>
                          </Link>
                        </SidebarMenuButton>
                      </TooltipTrigger>
                      <TooltipContent>{agent.name}</TooltipContent>
                    </Tooltip>
                  ) : (
                    <SidebarMenuButton asChild className={isActive ? "bg-accent text-accent-foreground font-medium" : ""}>
                      <Link href={agent.url} onClick={(e) => handleAgentClick(e, agent.threadId, agent.url)}>
                        {isAgentLoading ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <MessagesSquare className="h-4 w-4" />
                        )}
                        <span>{agent.name}</span>
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
                          navigator.clipboard.writeText(window.location.origin + agent.url)
                          toast.success("Link copied to clipboard")
                        }}>
                          <LinkIcon className="text-muted-foreground" />
                          <span>Copy Link</span>
                        </DropdownMenuItem>
                        <DropdownMenuItem asChild>
                          <a href={agent.url} target="_blank" rel="noopener noreferrer">
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
              );
            })}
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
