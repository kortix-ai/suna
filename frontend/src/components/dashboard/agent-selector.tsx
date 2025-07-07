'use client';

import React, { useState } from 'react';
import { ChevronDown, Plus, Star, Bot, Edit, User } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Badge } from '@/components/ui/badge';
import { useAgents } from '@/hooks/react-query/agents/use-agents';
import { useRouter } from 'next/navigation';
import { cn } from '@/lib/utils';
import { CreateAgentDialog } from '@/app/(dashboard)/agents/_components/create-agent-dialog';
import { useFeatureFlags } from '@/lib/feature-flags';

interface AgentSelectorProps {
  onAgentSelect?: (agentId: string | undefined) => void;
  selectedAgentId?: string;
  className?: string;
  variant?: 'default' | 'heading';
}

export function AgentSelector({ 
  onAgentSelect, 
  selectedAgentId, 
  className,
  variant = 'default',
}: AgentSelectorProps) {
  const { data: agentsResponse, isLoading, refetch: loadAgents } = useAgents({
    limit: 100,
    sort_by: 'name',
    sort_order: 'asc'
  });

  
  const { flags, loading: flagsLoading } = useFeatureFlags(['custom_agents']);
  const customAgentsEnabled = flags.custom_agents;
  
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(false);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);

  const agents = agentsResponse?.agents || [];
  const defaultAgent = agents.find(agent => agent.is_default);
  const currentAgent = selectedAgentId 
    ? agents.find(agent => agent.agent_id === selectedAgentId)
    : null;

  const displayName = currentAgent?.name || defaultAgent?.name || 'Suna';
  const agentAvatar = currentAgent?.avatar;
  const isUsingSuna = !currentAgent && !defaultAgent;

  const handleAgentSelect = (agentId: string | undefined) => {
    onAgentSelect?.(agentId);
    setIsOpen(false);
  };

  const handleCreateAgent = () => {
    setCreateDialogOpen(true);
    setIsOpen(false);
  };

  const handleManageAgents = () => {
    router.push('/agents');
    setIsOpen(false);
  };

  const handleClearSelection = () => {
    onAgentSelect?.(undefined);
    setIsOpen(false);
  };

  if (!customAgentsEnabled) {
    if (variant === 'heading') {
      return (
        <div className={cn("flex items-center", className)}>
          <span className="tracking-tight text-4xl font-semibold leading-tight text-primary">
            Suna
          </span>
        </div>
      );
    }
  }

  if (isLoading) {
    if (variant === 'heading') {
      return (
        <div className={cn("flex items-center", className)}>
          <span className="tracking-tight text-4xl font-semibold leading-tight text-muted-foreground">
            Loading...
          </span>
        </div>
      );
    }
    
    return (
      <div className={cn("flex items-center gap-2", className)}>
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg border bg-background">
          <Bot className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm text-muted-foreground">Loading agents...</span>
        </div>
      </div>
    );
  }

  if (variant === 'heading') {
    return (
      <>
        <div className={cn("flex items-center", className)}>
          <DropdownMenu open={isOpen} onOpenChange={setIsOpen}>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                className="flex items-center gap-1 px-2 py-1 h-auto hover:bg-transparent hover:text-primary transition-colors group"
              >
                <span className="underline decoration-dashed underline-offset-6 decoration-muted-foreground/50 tracking-tight text-4xl font-semibold leading-tight text-primary">
                  {displayName}
                  <span className="text-muted-foreground ml-2">
                    {agentAvatar && agentAvatar}
                  </span>
                </span>
                <div className="flex items-center opacity-60 group-hover:opacity-100 transition-opacity">
                  <ChevronDown className="h-5 w-5 text-muted-foreground" />
                  <Edit className="h-4 w-4 text-muted-foreground ml-1" />
                </div>
              </Button>
            </DropdownMenuTrigger>
            
            <DropdownMenuContent align="start" className="w-[320px]">
              <div className="px-3 py-2">
                <p className="text-sm font-medium">Select an agent</p>
                <p className="text-xs text-muted-foreground">You can create your own agent</p>
              </div>

              <DropdownMenuSeparator />
              
              <DropdownMenuItem
                onClick={() => handleClearSelection()}
                className="flex flex-col items-start gap-1 p-3 cursor-pointer"
              >
                <div className="flex items-center gap-2 w-full">
                  <User className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                  <div className="flex items-center gap-1 flex-1 min-w-0">
                    <span className="font-medium truncate">Suna</span>
                    <Badge variant="outline" className="text-xs px-1 py-0 flex-shrink-0">
                      Default
                    </Badge>
                  </div>
                  {isUsingSuna && (
                    <div className="h-2 w-2 rounded-full bg-primary flex-shrink-0" />
                  )}
                </div>
                <span className="text-xs text-muted-foreground pl-6 line-clamp-2">
                  Your personal AI employee
                </span>
              </DropdownMenuItem>
              {agents.length > 0 ? (
                <>
                  {agents.map((agent) => (
                    <DropdownMenuItem
                      key={agent.agent_id}
                      onClick={() => handleAgentSelect(agent.agent_id)}
                      className="flex flex-col items-start gap-1 p-3 cursor-pointer"
                    >
                      <div className="flex items-center gap-2 w-full">
                        {agent.avatar}
                        <div className="flex items-center gap-1 flex-1 min-w-0">
                          <span className="font-medium truncate">{agent.name}</span>
                          {agent.is_default && (
                            <Badge variant="secondary" className="text-xs px-1 py-0 flex-shrink-0">
                              <Star className="h-2.5 w-2.5 mr-0.5 fill-current" />
                              System
                            </Badge>
                          )}
                        </div>
                        {currentAgent?.agent_id === agent.agent_id && (
                          <div className="h-2 w-2 rounded-full bg-primary flex-shrink-0" />
                        )}
                      </div>
                      {agent.description && (
                        <span className="text-xs text-muted-foreground pl-6 line-clamp-2">
                          {agent.description}
                        </span>
                      )}
                    </DropdownMenuItem>
                  ))}
                </>
              ) : null}

              <DropdownMenuSeparator />
              
              <DropdownMenuItem onClick={handleCreateAgent} className="cursor-pointer">
                Agents
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </>
    );
  }

  return (
    <>
      <div className={cn("flex items-center gap-2", className)}>
        <DropdownMenu open={isOpen} onOpenChange={setIsOpen}>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              className="flex items-center gap-2 px-3 py-2 h-auto min-w-[200px] justify-between"
            >
              <div className="flex items-center gap-2">
                {isUsingSuna ? (
                  <User className="h-4 w-4 text-muted-foreground" />
                ) : (
                  <Bot className="h-4 w-4 text-muted-foreground" />
                )}
                <div className="flex flex-col items-start">
                  <div className="flex items-center gap-1">
                    <span className="text-sm font-medium">
                      {displayName}
                    </span>
                    {isUsingSuna && (
                      <Badge variant="outline" className="text-xs px-1 py-0">
                        Default
                      </Badge>
                    )}
                    {currentAgent?.is_default && (
                      <Badge variant="secondary" className="text-xs px-1 py-0">
                        <Star className="h-2.5 w-2.5 mr-0.5 fill-current" />
                        System
                      </Badge>
                    )}
                  </div>
                  {currentAgent?.description ? (
                    <span className="text-xs text-muted-foreground line-clamp-1 max-w-[150px]">
                      {currentAgent.description}
                    </span>
                  ) : isUsingSuna ? (
                    <span className="text-xs text-muted-foreground line-clamp-1 max-w-[150px]">
                      Your personal AI employee
                    </span>
                  ) : null}
                </div>
              </div>
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            </Button>
          </DropdownMenuTrigger>
          
          <DropdownMenuContent align="start" className="w-[280px]">
            <DropdownMenuItem
              onClick={() => handleClearSelection()}
              className="flex flex-col items-start gap-1 p-3 cursor-pointer"
            >
              <div className="flex items-center gap-2 w-full">
                <User className="h-4 w-4 text-muted-foreground" />
                <div className="flex items-center gap-1 flex-1">
                  <span className="font-medium">Suna</span>
                  <Badge variant="outline" className="text-xs px-1 py-0">
                    Default
                  </Badge>
                </div>
                {isUsingSuna && (
                  <div className="h-2 w-2 rounded-full bg-primary" />
                )}
              </div>
              <span className="text-xs text-muted-foreground pl-6 line-clamp-2">
                Your personal AI employee
              </span>
            </DropdownMenuItem>
            {agents.length > 0 ? (
              <>
                {agents.map((agent) => (
                  <DropdownMenuItem
                    key={agent.agent_id}
                    onClick={() => handleAgentSelect(agent.agent_id)}
                    className="flex flex-col items-start gap-1 p-3 cursor-pointer"
                  >
                    <div className="flex items-center gap-2 w-full">
                      <Bot className="h-4 w-4 text-muted-foreground" />
                      <div className="flex items-center gap-1 flex-1">
                        <span className="font-medium">{agent.name}</span>
                        {agent.is_default && (
                          <Badge variant="secondary" className="text-xs px-1 py-0">
                            <Star className="h-2.5 w-2.5 mr-0.5 fill-current" />
                            System
                          </Badge>
                        )}
                      </div>
                      {currentAgent?.agent_id === agent.agent_id && (
                        <div className="h-2 w-2 rounded-full bg-primary" />
                      )}
                    </div>
                    {agent.description && (
                      <span className="text-xs text-muted-foreground pl-6 line-clamp-2">
                        {agent.description}
                      </span>
                    )}
                  </DropdownMenuItem>
                ))}
              </>
            ) : null}
            
            <DropdownMenuSeparator />
            
            <DropdownMenuItem onClick={handleCreateAgent} className="cursor-pointer">
              <Plus className="h-4 w-4" />
              Create New Agent
            </DropdownMenuItem>
            
            <DropdownMenuItem onClick={handleManageAgents} className="cursor-pointer">
              <Bot className="h-4 w-4" />
              Manage All Agents
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      
      <CreateAgentDialog
        isOpen={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
        onAgentCreated={loadAgents}
      />
    </>
  );
}