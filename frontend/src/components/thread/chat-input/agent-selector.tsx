'use client';

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Settings, Bot, Search, Plus, Check, ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { useAgents } from '@/hooks/react-query/agents/use-agents';
import { NewAgentDialog } from '@/components/agents/new-agent-dialog';

import { useRouter } from 'next/navigation';
import { cn, truncateString } from '@/lib/utils';
import { KortixLogo } from '@/components/sidebar/kortix-logo';

interface AgentSelectorProps {
  selectedAgentId?: string;
  onAgentSelect?: (agentId: string | undefined) => void;
  disabled?: boolean;
  isSunaAgent?: boolean;
}

export const AgentSelector: React.FC<AgentSelectorProps> = ({
  selectedAgentId,
  onAgentSelect,
  disabled = false,
  isSunaAgent
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [highlightedIndex, setHighlightedIndex] = useState<number>(-1);
  const [showNewAgentDialog, setShowNewAgentDialog] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  const { data: agentsResponse, isLoading: agentsLoading } = useAgents();
  const agents = agentsResponse?.agents || [];

  const allAgents = [
    ...agents.map((agent: any) => ({
      ...agent,
      id: agent.agent_id,
      type: 'custom' as const,
      icon: agent.avatar || <Bot className="h-4 w-4" />
    }))
  ];

  const filteredAgents = allAgents.filter((agent) =>
    agent.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    agent.description?.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const sortedFilteredAgents = React.useMemo(() => {
    if (!selectedAgentId) {
      return filteredAgents;
    }
    
    const selectedAgent = filteredAgents.find(agent => agent.id === selectedAgentId);
    const otherAgents = filteredAgents.filter(agent => agent.id !== selectedAgentId);
    
    return selectedAgent ? [selectedAgent, ...otherAgents] : filteredAgents;
  }, [filteredAgents, selectedAgentId]);

  useEffect(() => {
    if (isOpen && searchInputRef.current) {
      setTimeout(() => {
        searchInputRef.current?.focus();
      }, 50);
    } else {
      setSearchQuery('');
      setHighlightedIndex(-1);
    }
  }, [isOpen]);

  const getAgentDisplay = () => {
    const selectedAgent = allAgents.find(agent => agent.id === selectedAgentId);
    if (selectedAgent) {
      console.log('Selected agent found:', selectedAgent.name, 'with ID:', selectedAgent.id);
      const isSelectedAgentSuna = selectedAgent.metadata?.is_suna_default || false;
      return {
        name: selectedAgent.name,
        icon: isSelectedAgentSuna ? <KortixLogo size={16} /> : selectedAgent.icon
      };
    }
    
    if (selectedAgentId !== undefined) {
      console.warn('Agent with ID', selectedAgentId, 'not found, falling back to Suna');
    }
    
    const defaultAgent = allAgents[0];
    const isDefaultAgentSuna = defaultAgent?.metadata?.is_suna_default || false;
    return {
      name: defaultAgent?.name || 'Suna',
      icon: isDefaultAgentSuna ? <KortixLogo size={16} /> : (defaultAgent?.icon || <KortixLogo size={16} />)
    };
  };

  const handleAgentSelect = (agentId: string | undefined) => {
    console.log('Agent selected:', agentId === undefined ? 'Suna (default)' : agentId);
    onAgentSelect?.(agentId);
    setIsOpen(false);
  };

  const handleAgentSettings = (agentId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setIsOpen(false);
    router.push(`/agents/config/${agentId}`);
  };

  const handleSearchInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation();
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightedIndex((prev) =>
        prev < sortedFilteredAgents.length - 1 ? prev + 1 : 0
      );
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightedIndex((prev) =>
        prev > 0 ? prev - 1 : sortedFilteredAgents.length - 1
      );
    } else if (e.key === 'Enter' && highlightedIndex >= 0) {
      e.preventDefault();
      const selectedAgent = sortedFilteredAgents[highlightedIndex];
      if (selectedAgent) {
        handleAgentSelect(selectedAgent.id);
      }
    }
  };

  const handleExploreAll = () => {
    setIsOpen(false);
    router.push('/agents');
  };

  const handleCreateAgent = useCallback(() => {
    setIsOpen(false);
    setShowNewAgentDialog(true);
  }, []);

  const renderAgentItem = (agent: any, index: number) => {
    const isSelected = agent.id === selectedAgentId;
    const isHighlighted = index === highlightedIndex;
    const hasSettings = agent.type === 'custom' && agent.id;
    const isThisAgentSuna = agent.metadata?.is_suna_default || false;

    return (
      <TooltipProvider key={agent.id || 'default'}>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuItem
              className={cn(
                "flex items-center rounded-xl gap-3 px-4 py-2.5 cursor-pointer hover:bg-accent/40 transition-colors duration-200 group",
                isHighlighted && "bg-accent/40"
              )}
              onClick={() => handleAgentSelect(agent.id)}
              onMouseEnter={() => setHighlightedIndex(index)}
            >
              <div className="flex-shrink-0">
                {isThisAgentSuna ? (
                  <KortixLogo size={16} />
                ) : (
                  agent.icon
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-sm text-foreground/90 truncate">
                    {agent.name}
                  </span>
                </div>
                <span className="text-xs text-muted-foreground/80 truncate leading-relaxed">
                  {truncateString(agent.description, 30)}
                </span>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                {hasSettings && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 w-6 p-0 hover:bg-muted/60 rounded-full opacity-0 group-hover:opacity-70 transition-opacity duration-200"
                    onClick={(e) => handleAgentSettings(agent.id, e)}
                  >
                    <Settings className="h-3 w-3" />
                  </Button>
                )}
                {isSelected && (
                  <div className="h-6 w-6 rounded-full bg-blue-500/10 flex items-center justify-center">
                    <Check className="h-3 w-3 text-blue-600/80" />
                  </div>
                )}
              </div>
            </DropdownMenuItem>
          </TooltipTrigger>
          <TooltipContent side="left" className="text-xs max-w-xs">
            <p className="truncate">{truncateString(agent.description, 35)}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  };

  const agentDisplay = getAgentDisplay();

  return (
    <>
      <DropdownMenu open={isOpen} onOpenChange={setIsOpen}>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className={cn(
                    "px-2.5 py-1.5 text-sm font-normal hover:bg-accent/40 transition-all duration-200 rounded-xl",
                    isOpen && "bg-accent/40"
                  )}
                  disabled={disabled}
                >
                  <div className="flex items-center gap-2">
                    <div className="flex-shrink-0">
                      {agentDisplay.icon}
                    </div>
                    <span className="hidden sm:inline-block truncate max-w-[80px] font-normal">
                      {agentDisplay.name}
                    </span>
                    <ChevronDown 
                      size={12} 
                      className={cn(
                        "opacity-50 transition-transform duration-200",
                        isOpen && "rotate-180"
                      )} 
                    />
                  </div>
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent>
              <p>Select Agent</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
        <DropdownMenuContent
          align="end"
          className="w-88 p-0 border-0 shadow-md bg-card/98 backdrop-blur-sm overflow-hidden h-[480px] flex flex-col"
          sideOffset={6}
          style={{
            borderRadius: '20px'
          }}
        >
          <div className="flex-shrink-0 p-4 pb-3">
            <div className="relative">
              <Search className="absolute left-3 top-2.5 h-3.5 w-3.5 text-muted-foreground/60" />
              <input
                ref={searchInputRef}
                type="text"
                placeholder="Search agents..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={handleSearchInputKeyDown}
                className={cn(
                  "w-full pl-10 pr-3 py-2 text-sm bg-muted/40 border-0 rounded-xl",
                  "focus:outline-none focus:ring-1 focus:ring-ring focus:ring-offset-0 focus:bg-muted/60",
                  "placeholder:text-muted-foreground/60 transition-all duration-200"
                )}
              />
            </div>
          </div>
          <div className="flex-1 overflow-y-auto scrollbar-thin scrollbar-thumb-muted-foreground/20 scrollbar-track-transparent px-1.5">
            {agentsLoading ? (
              <div className="px-4 py-6 text-sm text-muted-foreground/70 text-center">
                <div className="animate-pulse">Loading agents...</div>
              </div>
            ) : sortedFilteredAgents.length === 0 ? (
              <div className="px-4 py-6 text-sm text-muted-foreground/70 text-center">
                <Search className="h-6 w-6 mx-auto mb-2 opacity-40" />
                <p>No agents found</p>
                <p className="text-xs mt-1 opacity-60">Try adjusting your search</p>
              </div>
            ) : (
              <div className="space-y-0.5 pb-2">
                {sortedFilteredAgents.map((agent, index) => renderAgentItem(agent, index))}
              </div>
            )}
          </div>
          <div className="flex-shrink-0 p-4 pt-3 border-t border-border/40">
            <div className="flex items-center justify-center gap-3">
              <Button
                variant="ghost"
                size="sm"
                onClick={handleExploreAll}
                className="text-xs flex items-center gap-2 rounded-xl hover:bg-accent/40 transition-all duration-200 text-muted-foreground hover:text-foreground px-4 py-2"
              >
                <Search className="h-3.5 w-3.5" />
                Explore All Agents
              </Button>
              <div className="w-px h-4 bg-border/60" />
              <Button
                variant="ghost"
                size="sm"
                onClick={handleCreateAgent}
                className="text-xs flex items-center gap-2 rounded-xl hover:bg-accent/40 transition-all duration-200 text-muted-foreground hover:text-foreground px-4 py-2"
              >
                <Plus className="h-3.5 w-3.5" />
                Create Agent
              </Button>
            </div>
          </div>
        </DropdownMenuContent>
      </DropdownMenu>
      <NewAgentDialog 
        open={showNewAgentDialog} 
        onOpenChange={setShowNewAgentDialog}
      />
    </>
  );
}; 