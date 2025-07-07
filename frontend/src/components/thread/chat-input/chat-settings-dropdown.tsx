'use client';

import React, { useState, useRef, useEffect } from 'react';
import { Settings, ChevronRight, Bot, Presentation, FileSpreadsheet, Search, Plus, User, Check, ChevronDown } from 'lucide-react';
import Image from 'next/image';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Badge } from '@/components/ui/badge';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { useAgents } from '@/hooks/react-query/agents/use-agents';
import { ChatSettingsDialog } from './chat-settings-dialog';
import { useRouter } from 'next/navigation';
import { cn, truncateString } from '@/lib/utils';

interface PredefinedAgent {
  id: string;
  name: string;
  description: string;
  icon: React.ReactNode;
  category: 'productivity' | 'creative' | 'development';
}

const PREDEFINED_AGENTS: PredefinedAgent[] = [
  // {
  //   id: 'slides',
  //   name: 'Slides',
  //   description: 'Create stunning presentations and slide decks',
  //   icon: <Presentation className="h-4 w-4" />,
  //   category: 'productivity'
  // },
  // {
  //   id: 'sheets',
  //   name: 'Sheets',
  //   description: 'Spreadsheet and data analysis expert',
  //   icon: <FileSpreadsheet className="h-4 w-4" />,
  //   category: 'productivity'
  // }
];

interface ChatSettingsDropdownProps {
  selectedAgentId?: string;
  onAgentSelect?: (agentId: string | undefined) => void;
  selectedModel: string;
  onModelChange: (model: string) => void;
  modelOptions: any[];
  subscriptionStatus: any;
  canAccessModel: (modelId: string) => boolean;
  refreshCustomModels?: () => void;
  disabled?: boolean;
}

export const ChatSettingsDropdown: React.FC<ChatSettingsDropdownProps> = ({
  selectedAgentId,
  onAgentSelect,
  selectedModel,
  onModelChange,
  modelOptions,
  subscriptionStatus,
  canAccessModel,
  refreshCustomModels,
  disabled = false,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [highlightedIndex, setHighlightedIndex] = useState<number>(-1);
  const [dialogOpen, setDialogOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  const { data: agentsResponse, isLoading: agentsLoading } = useAgents();
  const agents = agentsResponse?.agents || [];

  // Combine all agents
  const allAgents = [
    {
      id: undefined,
      name: 'Suna',
      description: 'Your personal AI assistant',
      type: 'default' as const,
      icon: <Image src="/kortix-symbol.svg" alt="Suna" width={16} height={16} className="h-4 w-4 dark:invert" />
    },
    ...PREDEFINED_AGENTS.map(agent => ({
      ...agent,
      type: 'predefined' as const
    })),
    ...agents.map((agent: any) => ({
      ...agent,
      id: agent.agent_id,
      type: 'custom' as const,
      icon: agent.avatar || <Bot className="h-4 w-4" />
    }))
  ];

  // Filter agents based on search query
  const filteredAgents = allAgents.filter((agent) =>
    agent.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    agent.description?.toLowerCase().includes(searchQuery.toLowerCase())
  );

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
      return {
        name: selectedAgent.name,
        icon: selectedAgent.icon
      };
    }
    return {
      name: 'Suna',
      icon: <Image src="/kortix-symbol.svg" alt="Suna" width={16} height={16} className="h-4 w-4 dark:invert" />
    };
  };

  const handleAgentSelect = (agentId: string | undefined) => {
    onAgentSelect?.(agentId);
    setIsOpen(false);
  };

  const handleSearchInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation();
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightedIndex((prev) =>
        prev < filteredAgents.length - 1 ? prev + 1 : 0
      );
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightedIndex((prev) =>
        prev > 0 ? prev - 1 : filteredAgents.length - 1
      );
    } else if (e.key === 'Enter' && highlightedIndex >= 0) {
      e.preventDefault();
      const selectedAgent = filteredAgents[highlightedIndex];
      if (selectedAgent) {
        handleAgentSelect(selectedAgent.id);
      }
    }
  };

  const handleExploreAll = () => {
    setIsOpen(false);
    router.push('/agents');
  };

  const handleMoreOptions = () => {
    setIsOpen(false);
    setDialogOpen(true);
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
                  className="px-3 py-2 text-sm font-medium hover:bg-accent"
                  disabled={disabled}
                  style={{
                    borderRadius: '12px'
                  }}
                >
                  <div className="flex items-center gap-2">
                    {agentDisplay.icon}
                    <span className="hidden sm:inline-block truncate max-w-[80px]">
                      {agentDisplay.name}
                    </span>
                    <ChevronDown size={14} className="opacity-50" />
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
          className="w-80 p-0 border"
          sideOffset={4}
          style={{
            borderRadius: '16px'
          }}
        >
          <div className="p-4 border-b">
            <div className="relative">
              <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
              <input
                ref={searchInputRef}
                type="text"
                placeholder="Search agents..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={handleSearchInputKeyDown}
                className="w-full pl-10 pr-3 py-2 text-sm bg-transparent border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
              />
            </div>
          </div>

          <div className="max-h-80 overflow-y-auto scrollbar-thin scrollbar-thumb-muted-foreground/20 scrollbar-track-transparent">
            {agentsLoading ? (
              <div className="px-4 py-3 text-sm text-muted-foreground text-center">
                Loading agents...
              </div>
            ) : filteredAgents.length === 0 ? (
              <div className="px-4 py-3 text-sm text-muted-foreground text-center">
                No agents found
              </div>
            ) : (
              filteredAgents.map((agent, index) => {
                const isSelected = agent.id === selectedAgentId;
                const isHighlighted = index === highlightedIndex;

                return (
                  <TooltipProvider key={agent.id || 'default'}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <DropdownMenuItem
                          className={cn(
                            "flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-accent border-b m-0",
                            isHighlighted && "bg-accent",
                            index === filteredAgents.length - 1 && "border-b-0"
                          )}
                          style={{
                            borderRadius: '0'
                          }}
                          onClick={() => handleAgentSelect(agent.id)}
                          onMouseEnter={() => setHighlightedIndex(index)}
                        >
                          <div className="flex-shrink-0">
                            {agent.icon}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="font-semibold text-sm truncate">
                                {agent.name}
                              </span>
                              {agent.type === 'custom' && (
                                <Badge variant="outline" className="text-xs px-1 py-0 h-4">
                                  custom
                                </Badge>
                              )}
                            </div>
                            <span className="text-xs text-muted-foreground truncate">
                              {agent.description}
                            </span>
                          </div>
                          {isSelected && (
                            <Check className="h-4 w-4 text-blue-500 flex-shrink-0" />
                          )}
                        </DropdownMenuItem>
                      </TooltipTrigger>
                      <TooltipContent side="left" className="text-xs max-w-xs">
                        <p className="truncate">{truncateString(agent.description, 35)}</p>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                );
              })
            )}
          </div>

          <div className="border-t p-4">
            <div className="flex items-center justify-between gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={handleExploreAll}
                className="text-xs flex items-center gap-2"
              >
                <Search className="h-3 w-3" />
                Explore All
              </Button>

              <Button
                variant="outline"
                size="sm"
                onClick={handleMoreOptions}
                className="text-xs flex items-center gap-1"
              >
                <Settings className="h-3 w-3" />
                More Options
                <ChevronRight className="h-3 w-3" />
              </Button>
            </div>
          </div>
        </DropdownMenuContent>
      </DropdownMenu>

      <ChatSettingsDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        selectedModel={selectedModel}
        onModelChange={onModelChange}
        modelOptions={modelOptions}
        subscriptionStatus={subscriptionStatus}
        canAccessModel={canAccessModel}
        refreshCustomModels={refreshCustomModels}
      />
    </>
  );
}; 