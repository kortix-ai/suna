'use client';

import React, { useEffect, useMemo, useRef, useState, useCallback, memo } from 'react';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
    DropdownMenuSeparator,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
    DropdownMenuPortal,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Cpu, Search, Check, ChevronDown, Plus, ExternalLink, Loader2, Plug, Brain, LibraryBig, Zap, Workflow, Lock } from 'lucide-react';
import { useAgents } from '@/hooks/agents/use-agents';
import { KortixLogo } from '@/components/sidebar/kortix-logo';
import type { ModelOption } from '@/hooks/agents';
import { ModelProviderIcon } from '@/lib/model-provider-icons';
import { SpotlightCard } from '@/components/ui/spotlight-card';

export type SubscriptionStatus = 'no_subscription' | 'active';

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { IntegrationsRegistry } from '@/components/agents/integrations-registry';
import { useComposioToolkitIcon } from '@/hooks/composio/use-composio';
import { Skeleton } from '@/components/ui/skeleton';
import { useTranslations } from 'next-intl';
import { NewAgentDialog } from '@/components/agents/new-agent-dialog';
import { AgentAvatar } from '@/components/thread/content/agent-avatar';
import { AgentModelSelector } from '@/components/agents/config/model-selector';
import { AgentConfigurationDialog } from '@/components/agents/agent-configuration-dialog';
import { usePricingModalStore } from '@/stores/pricing-modal-store';

type UnifiedConfigMenuProps = {
    isLoggedIn?: boolean;

    // Agent
    selectedAgentId?: string;
    onAgentSelect?: (agentId: string | undefined) => void;

    // Model
    selectedModel: string;
    onModelChange: (modelId: string) => void;
    modelOptions: ModelOption[];
    subscriptionStatus: SubscriptionStatus;
    canAccessModel: (modelId: string) => boolean;
    refreshCustomModels?: () => void;
};

const LoggedInMenu: React.FC<UnifiedConfigMenuProps> = memo(function LoggedInMenu({
    isLoggedIn = true,
    selectedAgentId,
    onAgentSelect,
    selectedModel,
    onModelChange,
    modelOptions,
    canAccessModel,
    subscriptionStatus,
}) {
    const t = useTranslations('thread');
    const [isOpen, setIsOpen] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');
    const [debouncedSearchQuery, setDebouncedSearchQuery] = useState('');
    const [currentPage, setCurrentPage] = useState(1);
    const [allAgents, setAllAgents] = useState<any[]>([]);
    const searchContainerRef = useRef<HTMLDivElement>(null);
    const [integrationsOpen, setIntegrationsOpen] = useState(false);
    const [showNewAgentDialog, setShowNewAgentDialog] = useState(false);
    const searchInputRef = useRef<HTMLInputElement>(null);
    const [agentConfigDialog, setAgentConfigDialog] = useState<{ open: boolean; tab: 'instructions' | 'knowledge' | 'triggers' | 'tools' | 'integrations' }>({ open: false, tab: 'instructions' });

    // Debounce search query
    useEffect(() => {
        const timer = setTimeout(() => {
            setDebouncedSearchQuery(searchQuery);
            setCurrentPage(1); // Reset to first page when searching
        }, 300);
        return () => clearTimeout(timer);
    }, [searchQuery]);

    // Fetch agents with proper pagination and search
    // Note: sort params will be normalized by useAgents hook
    const agentsParams = useMemo(() => ({
        page: currentPage > 1 ? currentPage : undefined, // Only include if > 1
        limit: 50,
        search: debouncedSearchQuery || undefined,
    }), [currentPage, debouncedSearchQuery]);

    const { data: agentsResponse, isLoading, isFetching } = useAgents(agentsParams, { enabled: isLoggedIn });

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

    const agents: any[] = allAgents;

    // Find Suna agent for default display
    const sunaAgent = useMemo(() => {
        return agents.find(a => a.metadata?.is_suna_default === true);
    }, [agents]);
    
    // Create a placeholder Suna agent object for loading state
    const placeholderSunaAgent = useMemo(() => ({
        agent_id: undefined,
        name: 'Suna',
        metadata: { is_suna_default: true }
    }), []);

    // Only fetch integration icons when authenticated AND the menu is open
    const iconsEnabled = isLoggedIn && isOpen;
    const { data: googleDriveIcon } = useComposioToolkitIcon('googledrive', { enabled: iconsEnabled });
    const { data: slackIcon } = useComposioToolkitIcon('slack', { enabled: iconsEnabled });
    const { data: notionIcon } = useComposioToolkitIcon('notion', { enabled: iconsEnabled });

    useEffect(() => {
        if (isOpen) {
            setTimeout(() => searchInputRef.current?.focus(), 30);
        } else {
            setSearchQuery('');
            setDebouncedSearchQuery('');
            setCurrentPage(1);
        }
    }, [isOpen]);



    // Keep focus stable even when list size changes
    useEffect(() => {
        if (isOpen) searchInputRef.current?.focus();
    }, [searchQuery, isOpen]);

    const handleSearchInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        // Prevent Radix dropdown from stealing focus/navigation
        e.stopPropagation();
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
        }
    };

    // Order agents with selected first (server-side search already handles filtering)
    const orderedAgents = useMemo(() => {
        const list = [...agents];
        const selected = selectedAgentId ? list.find(a => a.agent_id === selectedAgentId) : undefined;
        const rest = selected ? list.filter(a => a.agent_id !== selectedAgentId) : list;
        return selected ? [selected, ...rest] : rest;
    }, [agents, selectedAgentId]);

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





    const handleAgentClick = useCallback((agentId: string | undefined) => {
        onAgentSelect?.(agentId);
        setIsOpen(false);
    }, [onAgentSelect]);

    const displayAgent = useMemo(() => {
        // If we have a selected agent, use it
        if (selectedAgentId) {
            const found = agents.find(a => a.agent_id === selectedAgentId);
            if (found) return found;
        }
        
        // Try to find Suna agent (default agent) first
        if (sunaAgent) return sunaAgent;
        
        // Fallback to first agent or undefined (will show "Suna" as default)
        return agents[0];
    }, [agents, selectedAgentId, sunaAgent]);

    const handleQuickAction = useCallback((action: 'instructions' | 'knowledge' | 'triggers' | 'tools') => {
        if (!selectedAgentId && !displayAgent?.agent_id) {
            return;
        }
        setAgentConfigDialog({ open: true, tab: action });
        setIsOpen(false);
    }, [selectedAgentId, displayAgent?.agent_id]);

    const renderAgentIcon = useCallback((agent: any) => {
        // If agent is undefined/null but we're showing Suna, use Suna icon
        if (!agent && (isLoading || sunaAgent)) {
            return <AgentAvatar isSunaDefault={true} agentName="Suna" size={32} className="flex-shrink-0 !border-0" />;
        }
        return <AgentAvatar agent={agent} agentId={agent?.agent_id} size={32} className="flex-shrink-0 !border-0" />;
    }, [isLoading, sunaAgent]);

    return (
        <>
            <DropdownMenu open={isOpen} onOpenChange={setIsOpen}>
                <DropdownMenuTrigger asChild>
                    <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 px-2 bg-transparent border-0 rounded-xl text-muted-foreground hover:text-foreground hover:bg-accent/50 flex items-center gap-1.5"
                        aria-label="Config menu"
                    >
                        {onAgentSelect ? (
                            <div className="flex items-center gap-2 min-w-0 max-w-[180px]">
                                {renderAgentIcon(isLoading && !displayAgent ? placeholderSunaAgent : displayAgent)}
                                <span className="truncate text-sm font-medium">
                                    {displayAgent?.name || 'Suna'}
                                </span>
                                <ChevronDown size={12} className="opacity-60 flex-shrink-0" />
                            </div>
                        ) : (
                            <div className="flex items-center gap-1.5">
                                <Cpu className="h-4 w-4" />
                                <ChevronDown size={12} className="opacity-60" />
                            </div>
                        )}
                    </Button>
                </DropdownMenuTrigger>

                <DropdownMenuContent align="end" className="w-[320px] px-0 py-3 border-[1.5px] border-border rounded-2xl" sideOffset={6}>
                    {/* Agents Submenu */}
                    {onAgentSelect && (
                        <>
                            <div className="px-3">
                                <div className="mb-3">
                                    <span className="text-xs font-medium text-muted-foreground">Agents</span>
                                </div>
                            </div>
                            <div className="px-2">
                                <SpotlightCard className="transition-colors cursor-pointer bg-transparent">
                                    <DropdownMenuSub>
                                        <DropdownMenuSubTrigger className="flex items-center gap-3 text-sm cursor-pointer px-1 py-1 hover:bg-transparent focus:bg-transparent data-[state=open]:bg-transparent w-full">
                                            <div className="flex items-center justify-center w-8 h-8 bg-card border-[1.5px] border-border flex-shrink-0" style={{ borderRadius: '10.4px' }}>
                                                {renderAgentIcon(isLoading && !displayAgent ? placeholderSunaAgent : displayAgent)}
                                            </div>
                                            <span className="flex-1 truncate font-medium text-left">{displayAgent?.name || 'Suna'}</span>
                                        </DropdownMenuSubTrigger>
                                        <DropdownMenuPortal>
                                            <DropdownMenuSubContent className="w-[320px] px-0 py-3 border-[1.5px] border-border rounded-2xl max-h-[500px] overflow-hidden" sideOffset={8}>
                                                <div className="mb-3 px-3">
                                                    <div className="relative">
                                                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-[18px] w-[18px] text-muted-foreground pointer-events-none" />
                                                        <input
                                                            ref={searchInputRef}
                                                            type="text"
                                                            placeholder="Search workers..."
                                                            value={searchQuery}
                                                            onChange={(e) => setSearchQuery(e.target.value)}
                                                            onKeyDown={handleSearchInputKeyDown}
                                                            className="w-full h-11 pl-10 pr-4 rounded-2xl text-sm font-medium bg-border focus:outline-none focus:ring-2 focus:ring-primary/50"
                                                        />
                                                    </div>
                                                </div>
                                                <div className="flex items-center justify-between mb-3 px-3">
                                                    <span className="text-xs font-medium text-muted-foreground">My Workers</span>
                                                    <Button
                                                        size="sm"
                                                        variant="ghost"
                                                        className="h-5 w-5 p-0 text-muted-foreground cursor-pointer hover:text-foreground hover:bg-card rounded-2xl"
                                                        onClick={() => { setIsOpen(false); setShowNewAgentDialog(true); }}
                                                    >
                                                        <Plus className="h-4 w-4" />
                                                    </Button>
                                                </div>
                                                {isLoading && orderedAgents.length === 0 ? (
                                                    <div className="space-y-2 px-2">
                                                        {Array.from({ length: 3 }).map((_, i) => (
                                                            <div key={i} className="flex items-center gap-3 p-3 rounded-2xl">
                                                                <div className="h-8 w-8 bg-muted/60 border-[1.5px] border-border rounded-2xl animate-pulse"></div>
                                                                <div className="h-4 bg-muted rounded flex-1 animate-pulse"></div>
                                                            </div>
                                                        ))}
                                                    </div>
                                                ) : orderedAgents.length === 0 ? (
                                                    <div className="p-6 text-center text-sm text-muted-foreground">
                                                        {debouncedSearchQuery ? 'No agents found' : 'No agents yet'}
                                                    </div>
                                                ) : (
                                                    <>
                                                        <div className="max-h-[340px] overflow-y-auto space-y-0.5 px-2 [&::-webkit-scrollbar]:hidden [-ms-overflow-style:'none'] [scrollbar-width:'none']">
                                                            {orderedAgents.map((agent) => {
                                                                const isActive = selectedAgentId === agent.agent_id;
                                                                return (
                                                                    <SpotlightCard
                                                                        key={agent.agent_id}
                                                                        className="transition-colors cursor-pointer bg-transparent"
                                                                    >
                                                                        <div
                                                                            className="flex items-center gap-3 text-sm cursor-pointer px-1 py-1"
                                                                            onClick={() => handleAgentClick(agent.agent_id)}
                                                                        >
                                                                            <div className="flex items-center justify-center w-8 h-8 bg-card border-[1.5px] border-border flex-shrink-0" style={{ borderRadius: '10.4px' }}>
                                                                                {renderAgentIcon(agent)}
                                                                            </div>
                                                                            <span className="flex-1 truncate font-medium">{agent.name}</span>
                                                                            {isActive && (
                                                                                <Check className="h-4 w-4 text-blue-500 flex-shrink-0" />
                                                                            )}
                                                                        </div>
                                                                    </SpotlightCard>
                                                                );
                                                            })}
                                                        </div>
                                                        {canLoadMore && (
                                                            <div className="pt-2 px-2">
                                                                <Button
                                                                    size="sm"
                                                                    variant="ghost"
                                                                    className="w-full h-8 text-sm text-muted-foreground hover:text-foreground rounded-2xl hover:bg-muted/60"
                                                                    onClick={handleLoadMore}
                                                                    disabled={isFetching}
                                                                >
                                                                    {isFetching ? (
                                                                        <>
                                                                            <Loader2 className="h-4 w-4 animate-spin mr-2" />
                                                                            Loading...
                                                                        </>
                                                                    ) : (
                                                                        `Load more`
                                                                    )}
                                                                </Button>
                                                            </div>
                                                        )}
                                                    </>
                                                )}
                                            </DropdownMenuSubContent>
                                        </DropdownMenuPortal>
                                    </DropdownMenuSub>
                                </SpotlightCard>
                            </div>
                            <div className="h-px bg-border/50 -mx-3 my-3" />
                        </>
                    )}

                    {/* Models Submenu */}
                    <div className="px-3">
                        <div className="mb-3">
                            <span className="text-xs font-medium text-muted-foreground">Models</span>
                        </div>
                    </div>
                    <div className="px-2">
                        <SpotlightCard className="transition-colors cursor-pointer bg-transparent">
                            <DropdownMenuSub>
                                <DropdownMenuSubTrigger className="flex items-center gap-3 text-sm cursor-pointer px-1 py-1 hover:bg-transparent focus:bg-transparent data-[state=open]:bg-transparent w-full">
                                    <ModelProviderIcon
                                        modelId={selectedModel}
                                        size={32}
                                        className="flex-shrink-0"
                                    />
                                    <span className="flex-1 truncate font-medium text-left">
                                        {modelOptions.find(m => m.id === selectedModel)?.label || 'Select Model'}
                                    </span>
                                </DropdownMenuSubTrigger>
                                <DropdownMenuPortal>
                                    <DropdownMenuSubContent className="w-[320px] p-3 border-[1.5px] border-border rounded-2xl max-h-[500px] overflow-y-auto" sideOffset={8}>
                                        <div className="mb-3">
                                            <span className="text-xs font-medium text-muted-foreground pl-1">Available Models</span>
                                        </div>
                                        <div className="space-y-0.5">
                                            {modelOptions.map((model) => {
                                                const isActive = selectedModel === model.id;
                                                const canAccess = canAccessModel(model.id);
                                                const modelItem = (
                                                    <SpotlightCard
                                                        key={model.id}
                                                        className={cn(
                                                            "transition-colors cursor-pointer bg-transparent",
                                                            !canAccess && "opacity-60"
                                                        )}
                                                    >
                                                        <div
                                                            className="flex items-center gap-3 text-sm cursor-pointer px-1 py-1 relative"
                                                            onClick={() => {
                                                                if (canAccess) {
                                                                    onModelChange(model.id);
                                                                    setIsOpen(false);
                                                                } else {
                                                                    setIsOpen(false);
                                                                    usePricingModalStore.getState().openPricingModal({ 
                                                                        isAlert: true, 
                                                                        alertTitle: 'Upgrade to access this AI model' 
                                                                    });
                                                                }
                                                            }}
                                                        >
                                                            <ModelProviderIcon
                                                                modelId={model.id}
                                                                size={32}
                                                                className={cn("flex-shrink-0", !canAccess && "opacity-50")}
                                                            />
                                                            <span className={cn("flex-1 truncate font-medium", !canAccess && "text-muted-foreground")}>{model.label}</span>
                                                            {!canAccess && (
                                                                <Lock className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                                                            )}
                                                            {isActive && canAccess && (
                                                                <Check className="h-4 w-4 text-blue-500 flex-shrink-0" />
                                                            )}
                                                        </div>
                                                    </SpotlightCard>
                                                );

                                                if (!canAccess) {
                                                    return (
                                                        <TooltipProvider key={model.id}>
                                                            <Tooltip>
                                                                <TooltipTrigger asChild>
                                                                    {modelItem}
                                                                </TooltipTrigger>
                                                                <TooltipContent side="left" className="text-xs">
                                                                    <p>Upgrade to access this model</p>
                                                                </TooltipContent>
                                                            </Tooltip>
                                                        </TooltipProvider>
                                                    );
                                                }

                                                return modelItem;
                                            })}
                                        </div>
                                    </DropdownMenuSubContent>
                                </DropdownMenuPortal>
                            </DropdownMenuSub>
                        </SpotlightCard>
                    </div>
                    <div className="h-px bg-border/50 -mx-3 my-3" />
                    {onAgentSelect && (selectedAgentId || displayAgent?.agent_id) && (
                        <div className="px-3">
                            <div className="mb-3">
                                <span className="text-xs font-medium text-muted-foreground">Worker Settings</span>
                            </div>
                            <div className="flex justify-between items-center gap-2">
                                {[
                                    { action: 'instructions' as const, icon: Plug },
                                    { action: 'knowledge' as const, icon: Brain },
                                    { action: 'integrations' as const, icon: LibraryBig },
                                    { action: 'triggers' as const, icon: Zap },
                                ].map(({ action, icon: Icon }) => (
                                    <Button
                                        key={action}
                                        variant="ghost"
                                        size="icon"
                                        className="h-8 flex-1 p-0 cursor-pointer hover:bg-muted/60 border-[1.5px] border-border rounded-2xl"
                                        onClick={() => action === 'integrations' ? setIntegrationsOpen(true) : handleQuickAction(action as any)}
                                    >
                                        <Icon className="h-4 w-4" />
                                    </Button>
                                ))}
                            </div>
                        </div>
                    )}
                </DropdownMenuContent>
            </DropdownMenu>
            <Dialog open={integrationsOpen} onOpenChange={setIntegrationsOpen}>
                <DialogContent className="p-0 max-w-6xl h-[90vh] overflow-hidden">
                    <DialogHeader className="sr-only">
                        <DialogTitle>Integrations</DialogTitle>
                    </DialogHeader>
                    <IntegrationsRegistry
                        showAgentSelector={true}
                        selectedAgentId={selectedAgentId}
                        onAgentChange={onAgentSelect}
                        onClose={() => setIntegrationsOpen(false)}
                    />
                </DialogContent>
            </Dialog>
            <NewAgentDialog
                open={showNewAgentDialog}
                onOpenChange={setShowNewAgentDialog}
                onSuccess={(agentId) => {
                    setShowNewAgentDialog(false);
                    onAgentSelect?.(agentId);
                }}
            />
            {(selectedAgentId || displayAgent?.agent_id) && agentConfigDialog.open && (
                <AgentConfigurationDialog
                    open={agentConfigDialog.open}
                    onOpenChange={(open) => setAgentConfigDialog({ ...agentConfigDialog, open })}
                    agentId={selectedAgentId || displayAgent?.agent_id}
                    initialTab={agentConfigDialog.tab}
                    onAgentChange={onAgentSelect}
                />
            )}

        </>
    );
});

const GuestMenu: React.FC<UnifiedConfigMenuProps> = memo(function GuestMenu() {
    return (
        <TooltipProvider>
            <Tooltip>
                <TooltipTrigger asChild>
                    <span className="inline-flex">
                        <Button
                            variant="ghost"
                            size="sm"
                            className="h-8 px-2 bg-border border-0 rounded-xl text-muted-foreground hover:text-foreground hover:bg-accent/50 flex items-center gap-1.5 cursor-not-allowed opacity-80 pointer-events-none"
                            disabled
                        >
                            <div className="flex items-center gap-2 min-w-0 max-w-[180px]">
                                <div className="flex-shrink-0">
                                    <KortixLogo size={20} />
                                </div>
                                <span className="truncate text-sm font-medium">Suna</span>
                                <ChevronDown size={12} className="opacity-60 flex-shrink-0" />
                            </div>
                        </Button>
                    </span>
                </TooltipTrigger>
                <TooltipContent side="top" className="text-xs">
                    <p>Log in to change agent</p>
                </TooltipContent>
            </Tooltip>
        </TooltipProvider>
    );
});

export const UnifiedConfigMenu: React.FC<UnifiedConfigMenuProps> = (props) => {
    if (props.isLoggedIn) {
        return <LoggedInMenu {...props} />;
    }
    return <GuestMenu {...props} />;
};

export default UnifiedConfigMenu;


