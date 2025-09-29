'use client';

import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { Search, Plus, Check, ChevronDown, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { useAgents } from '@/hooks/react-query/agents/use-agents';
import { NewAgentDialog } from '@/components/agents/new-agent-dialog';
import { cn } from '@/lib/utils';
import { AgentAvatar } from '@/components/thread/content/agent-avatar';
import { Skeleton } from '@/components/ui/skeleton';

interface AgentSelectorProps {
  selectedAgentId?: string;
  onAgentSelect: (agentId: string) => void;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  showCreateOption?: boolean;
  variant?: 'default' | 'compact';
}

export const AgentSelector: React.FC<AgentSelectorProps> = ({
  selectedAgentId,
  onAgentSelect,
  placeholder = "Choose an agent",
  className,
  disabled = false,
  showCreateOption = true,
  variant = 'default'
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const [allAgents, setAllAgents] = useState<any[]>([]);
  const [showNewAgentDialog, setShowNewAgentDialog] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Debounce search query
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearchQuery(searchQuery);
      setCurrentPage(1); // Reset to first page when searching
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  // Fetch agents with pagination and search
  const agentsParams = useMemo(() => ({
    page: currentPage,
    limit: 50,
    search: debouncedSearchQuery || undefined,
  }), [currentPage, debouncedSearchQuery]);

  const { data: agentsResponse, isLoading, isFetching } = useAgents(agentsParams);

  // Update agents list when data changes
  useEffect(() => {
    if (agentsResponse?.agents) {
      if (currentPage === 1 || debouncedSearchQuery) {
        // First page or new search - replace all agents
        setAllAgents(agentsResponse.agents);
      } else {
        // Subsequent pages - append to existing agents
        setAllAgents(prev => [...prev, ...agentsResponse.agents]);
      }
    }
  }, [agentsResponse, currentPage, debouncedSearchQuery]);

  const agents = allAgents;

  // Check if we can load more
  const canLoadMore = useMemo(() => {
    if (!agentsResponse?.pagination) return false;
    return agentsResponse.pagination.current_page < agentsResponse.pagination.total_pages;
  }, [agentsResponse?.pagination]);

  const handleLoadMore = useCallback(() => {
    if (canLoadMore && !isFetching) {
      setCurrentPage(prev => prev + 1);
    }
  }, [canLoadMore, isFetching]);

  // Order agents with selected first
  const orderedAgents = useMemo(() => {
    const list = [...agents];
    if (!selectedAgentId) return list;
    
    const selectedIndex = list.findIndex(a => a.agent_id === selectedAgentId);
    if (selectedIndex > 0) {
      const [selected] = list.splice(selectedIndex, 1);
      list.unshift(selected);
    }
    return list;
  }, [agents, selectedAgentId]);

  useEffect(() => {
    if (isOpen) {
      setTimeout(() => searchInputRef.current?.focus(), 50);
    } else {
      setSearchQuery('');
      setDebouncedSearchQuery('');
      setCurrentPage(1);
    }
  }, [isOpen]);

  const handleAgentSelect = (agentId: string) => {
    onAgentSelect(agentId);
    setIsOpen(false);
  };

  const handleCreateAgent = () => {
    setIsOpen(false);
    setShowNewAgentDialog(true);
  };

  const selectedAgent = agents.find((agent: any) => agent.agent_id === selectedAgentId);

  const renderTriggerContent = () => {
    if (selectedAgent) {
      return (
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <AgentAvatar
            agentId={selectedAgent.agent_id}
            size={24}
            className="flex-shrink-0"
            fallbackName={selectedAgent.name}
          />
          <span className="truncate font-medium">
            {selectedAgent.name}
          </span>
          <ChevronDown size={12} className="opacity-60 flex-shrink-0" />
        </div>
      );
    }

    return (
      <div className="flex items-center gap-2 text-muted-foreground">
        <span>{placeholder}</span>
        <ChevronDown size={12} className="opacity-60" />
      </div>
    );
  };

  return (
    <>
      <DropdownMenu open={isOpen} onOpenChange={setIsOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            className={cn(
              "w-full justify-start h-10 px-3 py-2 border-input bg-background hover:bg-accent hover:text-accent-foreground",
              !selectedAgent && "text-muted-foreground",
              className
            )}
            disabled={disabled}
          >
            {renderTriggerContent()}
          </Button>
        </DropdownMenuTrigger>

        <DropdownMenuContent
          className="w-80 p-0"
          align="start"
          sideOffset={4}
        >
          {/* Search */}
          <div className="p-3 pb-2">
            <div className="relative">
              <Search className="absolute left-3 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
              <input
                ref={searchInputRef}
                type="text"
                placeholder="Search agents..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-9 pr-3 py-2 text-sm bg-muted/40 border-0 rounded-lg focus:outline-none focus:ring-1 focus:ring-ring focus:bg-muted/60 placeholder:text-muted-foreground/60"
              />
            </div>
          </div>

          {/* Agent List */}
          <div className="max-h-64 overflow-y-auto px-1">
            {isLoading ? (
              <div className="px-3 py-2 space-y-2">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="flex items-center gap-3">
                    <Skeleton className="h-5 w-5 rounded-full" />
                    <Skeleton className="h-4 flex-1" />
                  </div>
                ))}
              </div>
            ) : orderedAgents.length === 0 ? (
              <div className="px-3 py-6 text-center text-sm text-muted-foreground">
                <Search className="h-6 w-6 mx-auto mb-2 opacity-40" />
                <p>No agents found</p>
                {searchQuery && (
                  <p className="text-xs mt-1 opacity-60">Try adjusting your search</p>
                )}
              </div>
            ) : (
              <div className="space-y-0.5 py-1">
                {orderedAgents.map((agent: any) => (
                  <DropdownMenuItem
                    key={agent.agent_id}
                    className="flex items-center gap-3 px-3 py-2.5 mx-1 rounded-lg cursor-pointer"
                    onClick={() => handleAgentSelect(agent.agent_id)}
                  >
                    <AgentAvatar
                      agentId={agent.agent_id}
                      size={24}
                      className="flex-shrink-0"
                      fallbackName={agent.name}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-sm truncate">
                        {agent.name}
                      </div>
                      {agent.description && (
                        <div className="text-xs text-muted-foreground truncate">
                          {agent.description}
                        </div>
                      )}
                    </div>
                    {selectedAgentId === agent.agent_id && (
                      <Check className="h-4 w-4 text-blue-500 flex-shrink-0" />
                    )}
                  </DropdownMenuItem>
                ))}
              </div>
            )}
          </div>

          {/* Load More */}
          {canLoadMore && (
            <div className="px-1.5 pb-1">
              <Button
                size="sm"
                variant="ghost"
                className="w-full h-8 text-xs text-muted-foreground hover:text-foreground"
                onClick={handleLoadMore}
                disabled={isFetching}
              >
                {isFetching ? (
                  <>
                    <Loader2 className="h-3 w-3 animate-spin mr-1" />
                    Loading...
                  </>
                ) : (
                  'Load More'
                )}
              </Button>
            </div>
          )}

          {/* Create Agent Option */}
          {showCreateOption && (
            <>
              <DropdownMenuSeparator />
              <div className="p-1">
                <DropdownMenuItem
                  className="flex items-center gap-3 px-3 py-2.5 mx-0 rounded-lg cursor-pointer text-muted-foreground hover:text-foreground"
                  onClick={handleCreateAgent}
                >
                  <Plus className="h-4 w-4" />
                  <span className="font-medium">Create new agent</span>
                </DropdownMenuItem>
              </div>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* New Agent Dialog */}
      <NewAgentDialog
        open={showNewAgentDialog}
        onOpenChange={setShowNewAgentDialog}
        onSuccess={(agentId) => {
          if (agentId) {
            onAgentSelect(agentId);
          }
        }}
      />
    </>
  );
};
