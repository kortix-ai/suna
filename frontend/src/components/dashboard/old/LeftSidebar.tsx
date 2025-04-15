"use client";
import Link from "next/link";
import { Search, MessagesSquare, ArrowRight, PanelLeft, X } from "lucide-react";
import { useState, useEffect } from "react";
import UserAccountPanel from "@/components/dashboard/old/user-account-panel";
import NavItem from "@/components/dashboard/old/NavItem";
import { getProjects, getThreads } from "@/lib/api";

interface LeftSidebarProps {
  accountId: string;
  userName?: string;
  userEmail?: string;
  isCollapsed: boolean;
  toggleCollapsed: () => void;
}

export default function LeftSidebar({
  accountId,
  userName,
  userEmail,
  isCollapsed,
  toggleCollapsed,
}: LeftSidebarProps) {
  // Add search state for agents
  const [searchQuery, setSearchQuery] = useState("");
  const [filteredAgents, setFilteredAgents] = useState<{name: string, href: string}[]>([]);
  const [showSearchInput, setShowSearchInput] = useState(false);
  const [agents, setAgents] = useState<{name: string, href: string}[]>([]);
  const [isLoadingAgents, setIsLoadingAgents] = useState(true);
  
  // Filter agents when search query changes
  useEffect(() => {
    if (searchQuery.trim() === "") {
      setFilteredAgents(agents);
    } else {
      const filtered = agents.filter(agent => 
        agent.name.toLowerCase().includes(searchQuery.toLowerCase())
      );
      setFilteredAgents(filtered);
    }
  }, [searchQuery, agents]);
  
  // Load agents dynamically from the API
  useEffect(() => {
    async function loadAgents() {
      try {
        const projectsData = await getProjects();
        const agentsList = [];
        
        for (const project of projectsData) {
          const threads = await getThreads(project.id);
          if (threads && threads.length > 0) {
            // For each thread in the project, create an agent entry
            for (const thread of threads) {
              agentsList.push({
                name: `${project.name} - ${thread.thread_id.slice(0, 4)}`,
                href: `/dashboard/agents/${thread.thread_id}`
              });
            }
          }
        }
        
        // Sort by most recent
        setAgents(agentsList);
      } catch (err) {
        console.error("Error loading agents for sidebar:", err);
      } finally {
        setIsLoadingAgents(false);
      }
    }
    
    loadAgents();
  }, []);

  // Get only the latest 20 agents for the sidebar
  const recentAgents = filteredAgents.slice(0, 20);

  return (
    <div
      className={`transition-all duration-300 ease-in-out ${
        !isCollapsed ? "w-56" : "w-12"
      }`}
    >
      <div
        className="flex flex-col h-full bg-background"
        style={{ backdropFilter: "blur(8px)" }}
      >
        <div className="h-12 p-2 flex items-center justify-between">
          <div className={`font-medium text-sm text-card-title ${isCollapsed ? "hidden" : "block"}`}>
            <Link href="/">AgentPress</Link>
          </div>
          <button
            onClick={toggleCollapsed}
            className={`p-1 hover:bg-hover-bg text-foreground/60 transition-all duration-200 ${isCollapsed ? "mx-auto" : ""}`}
            aria-label={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            <PanelLeft size={14} className={`transition-transform duration-200 ${isCollapsed ? "rotate-180" : ""}`} />
          </button>
        </div>

        <div className="px-2 pb-2 border-b border-subtle dark:border-white/10">
          <UserAccountPanel
            accountId={accountId}
            userName={userName}
            userEmail={userEmail}
            isCollapsed={isCollapsed}
          />
        </div>

        <div className="flex-1 overflow-y-auto pt-2">
          {/* Agents Section */}
          <div className="py-1 px-2 mt-2">
            <div className={`flex justify-between items-center mb-1 ${isCollapsed ? "hidden" : "block"}`}>
              <Link href="/dashboard/agents" className="text-xs font-medium text-foreground/50">Agents</Link>
              <div className="flex items-center gap-1">
                {!isCollapsed && (
                  <button
                    onClick={() => setShowSearchInput(!showSearchInput)}
                    className="text-xs flex items-center justify-center h-5 w-5 rounded-md bg-background-secondary/80 hover:bg-hover-bg text-foreground/50 hover:text-foreground transition-colors duration-200 border border-subtle/40 dark:border-white/5"
                    aria-label="Search agents"
                  >
                    <Search size={12} className="text-icon-color" />
                  </button>
                )}
                <Link 
                  href="/dashboard" 
                  className="text-xs flex items-center justify-center px-1.5 h-5 rounded-md bg-background-secondary/80 hover:bg-hover-bg text-foreground/50 hover:text-foreground transition-colors duration-200 border border-subtle/40 dark:border-white/5"
                >
                  + New
                </Link>
              </div>
            </div>
            
            {/* Add search input for agents - only show when search is clicked */}
            {!isCollapsed && (
              <div 
                className={`overflow-hidden transition-all duration-300 ease-in-out ${
                  showSearchInput ? 'max-h-10 opacity-100 mb-2' : 'max-h-0 opacity-0 mb-0'
                }`}
              >
                <div className={`relative transition-transform duration-300 ${
                  showSearchInput ? 'translate-y-0' : '-translate-y-4'
                }`}>
                  <div className="absolute inset-y-0 left-0 pl-2 flex items-center pointer-events-none">
                    <Search size={12} className="text-icon-color" />
                  </div>
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search agents..."
                    className="w-full py-1 pl-7 pr-2 text-xs bg-background-secondary border border-subtle dark:border-white/10 rounded-md placeholder-foreground/40 focus:outline-none focus:ring-1 focus:ring-primary"
                    autoFocus={showSearchInput}
                    tabIndex={showSearchInput ? 0 : -1}
                  />
                  {searchQuery && (
                    <button 
                      className="absolute inset-y-0 right-0 pr-2 flex items-center"
                      onClick={() => setSearchQuery("")}
                    >
                      <X size={12} className="text-icon-color" />
                    </button>
                  )}
                </div>
              </div>
            )}
            
            <div className="space-y-0.5">
              {isLoadingAgents ? (
                // Show skeleton loaders while loading
                Array.from({length: 3}).map((_, index) => (
                  <div key={index} className="flex items-center gap-2 py-1.5 px-2">
                    {!isCollapsed && (
                      <div className="w-4 h-4 bg-foreground/10 rounded-md animate-pulse"></div>
                    )}
                    {!isCollapsed && (
                      <div className="h-3 bg-foreground/10 rounded w-3/4 animate-pulse"></div>
                    )}
                  </div>
                ))
              ) : recentAgents.length > 0 ? (
                // Show only the latest 20 agents
                <>
                  {recentAgents.map((agent, index) => (
                    <NavItem
                      key={index}
                      icon={<MessagesSquare size={16} />}
                      label={agent.name}
                      href={agent.href}
                      isCollapsed={isCollapsed}
                      hideIconWhenCollapsed={true}
                    />
                  ))}
                  
                  {/* "See all agents" link */}
                  {filteredAgents.length > 20 && (
                    <Link 
                      href="/dashboard/agents" 
                      className={`flex items-center gap-1 py-1.5 px-2 text-xs text-foreground/60 hover:text-foreground hover:bg-hover-bg transition-all ${
                        isCollapsed ? "justify-center" : ""
                      }`}
                    >
                      {!isCollapsed && <span>See all agents</span>}
                      <ArrowRight size={12} />
                    </Link>
                  )}
                </>
              ) : (
                // Show empty state with search query info if applicable
                <div className={`text-xs text-foreground/50 p-2 ${isCollapsed ? "hidden" : "block"}`}>
                  {searchQuery ? `No agents matching "${searchQuery}"` : "No agents yet"}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
} 