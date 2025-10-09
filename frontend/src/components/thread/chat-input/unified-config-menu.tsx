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
import { Cpu, Search, Check, ChevronDown, Plus, ExternalLink, Loader2 } from 'lucide-react';
import { useAgents } from '@/hooks/react-query/agents/use-agents';
import { KortixLogo } from '@/components/sidebar/kortix-logo';
import type { ModelOption } from '@/hooks/use-model-selection';

export type SubscriptionStatus = 'no_subscription' | 'active';

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { IntegrationsRegistry } from '@/components/agents/integrations-registry';
import { useComposioToolkitIcon } from '@/hooks/react-query/composio/use-composio';
import { Skeleton } from '@/components/ui/skeleton';
import { NewAgentDialog } from '@/components/agents/new-agent-dialog';
import { AgentAvatar } from '@/components/thread/content/agent-avatar';
import { AgentModelSelector } from '@/components/agents/config/model-selector';
import { AgentConfigurationDialog } from '@/components/agents/agent-configuration-dialog';

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
    onUpgradeRequest?: () => void;
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
    onUpgradeRequest,
}) {
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
    const agentsParams = useMemo(() => ({
        page: currentPage,
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
        const found = agents.find(a => a.agent_id === selectedAgentId) || agents[0];
        return found;
    }, [agents, selectedAgentId]);

    const handleQuickAction = useCallback((action: 'instructions' | 'knowledge' | 'triggers' | 'tools') => {
        if (!selectedAgentId && !displayAgent?.agent_id) {
            return;
        }
        setAgentConfigDialog({ open: true, tab: action });
        setIsOpen(false);
    }, [selectedAgentId, displayAgent?.agent_id]);

    const renderAgentIcon = useCallback((agent: any) => {
        return <AgentAvatar agentId={agent?.agent_id} size={24} className="flex-shrink-0" fallbackName={agent?.name} />;
    }, []);

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
                                {renderAgentIcon(displayAgent)}
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

                <DropdownMenuContent align="end" className="w-80 p-0" sideOffset={6}>
                    <div className="p-2" ref={searchContainerRef}>
                        <div className="relative">
                            <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
                            <input
                                ref={searchInputRef}
                                type="text"
                                placeholder="Search..."
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                                onKeyDown={handleSearchInputKeyDown}
                                className="w-full h-8 pl-8 pr-2 rounded-lg text-sm bg-muted focus:outline-none"
                            />
                        </div>
                    </div>

                    {/* Agents */}
                    {onAgentSelect && (
                        <div className="px-1.5">
                            <div className="px-3 py-1 text-[11px] font-medium text-muted-foreground flex items-center justify-between">
                                <span>Agents</span>
                                <Button
                                    size="sm"
                                    variant="ghost"
                                    className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground"
                                    onClick={() => { setIsOpen(false); setShowNewAgentDialog(true); }}
                                >
                                    <Plus className="h-3.5 w-3.5" />
                                </Button>
                            </div>
                            {isLoading && orderedAgents.length === 0 ? (
                                <div className="px-3 py-2 text-xs text-muted-foreground">Loading agents...</div>
                            ) : orderedAgents.length === 0 ? (
                                <div className="px-3 py-2 text-xs text-muted-foreground">
                                    {debouncedSearchQuery ? 'No agents found' : 'No agents'}
                                </div>
                            ) : (
                                <>
                                    <div className="max-h-[200px] overflow-y-auto">
                                        {orderedAgents.map((agent) => (
                                            <DropdownMenuItem
                                                key={agent.agent_id}
                                                className="text-sm px-3 py-2 mx-0 my-0.5 flex items-center justify-between cursor-pointer rounded-lg"
                                                onClick={() => handleAgentClick(agent.agent_id)}
                                            >
                                                <div className="flex items-center gap-3 min-w-0 flex-1">
                                                    {renderAgentIcon(agent)}
                                                    <span className="truncate font-medium">{agent.name}</span>
                                                </div>
                                                {selectedAgentId === agent.agent_id && (
                                                    <Check className="h-4 w-4 text-blue-500 flex-shrink-0" />
                                                )}
                                            </DropdownMenuItem>
                                        ))}
                                    </div>
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
                                </>
                            )}

                            {/* Agents "see all" removed; scroll container shows all */}
                        </div>
                    )}

                    {onAgentSelect && <DropdownMenuSeparator className="!mt-0" />}

                    {/* Models */}
                    <div className="px-1.5">
                        <div className="px-3 py-1 text-[11px] font-medium text-muted-foreground">Models</div>
                        <AgentModelSelector
                            value={selectedModel}
                            onChange={onModelChange}
                            disabled={false}
                            variant="menu-item"
                        />
                    </div>
                    <DropdownMenuSeparator />
                    {onAgentSelect && (selectedAgentId || displayAgent?.agent_id) && (
                        <div className="px-1.5">
                            <DropdownMenuItem
                                className="text-sm px-3 py-2 mx-0 my-0.5 flex items-center gap-2 cursor-pointer rounded-lg"
                                onClick={() => handleQuickAction('instructions')}
                            >
                                <span className="font-medium">Instructions</span>
                            </DropdownMenuItem>
                            <DropdownMenuItem
                                className="text-sm px-3 py-2 mx-0 my-0.5 flex items-center gap-2 cursor-pointer rounded-lg"
                                onClick={() => handleQuickAction('tools')}
                            >
                                <span className="font-medium">Tools</span>
                            </DropdownMenuItem>
                            <DropdownMenuItem
                                className="text-sm px-3 py-2 mx-0 my-0.5 flex items-center gap-2 cursor-pointer rounded-lg"
                                onClick={() => handleQuickAction('knowledge')}
                            >
                                <span className="font-medium">Knowledge</span>
                            </DropdownMenuItem>
                            <DropdownMenuItem
                                className="text-sm px-3 py-2 mx-0 my-0.5 flex items-center gap-2 cursor-pointer rounded-lg"
                                onClick={() => handleQuickAction('triggers')}
                            >
                                <span className="font-medium">Triggers</span>
                            </DropdownMenuItem>
                            <TooltipProvider>
                                <Tooltip>
                                    <TooltipTrigger asChild>
                                        <DropdownMenuItem
                                            className="text-sm px-3 py-2 mx-0 my-0.5 flex items-center justify-between cursor-pointer rounded-lg"
                                            onClick={() => setIntegrationsOpen(true)}
                                        >
                                            <span className="font-medium">Integrations</span>
                                            <div className="flex items-center gap-1.5">
                                                {googleDriveIcon?.icon_url && slackIcon?.icon_url && notionIcon?.icon_url ? (
                                                    <>
                                                        {/* eslint-disable-next-line @next/next/no-img-element */}
                                                        <img src={googleDriveIcon.icon_url} className="w-4 h-4" alt="Google Drive" />
                                                        {/* eslint-disable-next-line @next/next/no-img-element */}
                                                        <img src={slackIcon.icon_url} className="w-3.5 h-3.5" alt="Slack" />
                                                        {/* eslint-disable-next-line @next/next/no-img-element */}
                                                        <img src={notionIcon.icon_url} className="w-3.5 h-3.5" alt="Notion" />
                                                    </>
                                                ) : (
                                                    <>
                                                        <Skeleton className="w-4 h-4 rounded" />
                                                        <Skeleton className="w-3.5 h-3.5 rounded" />
                                                        <Skeleton className="w-3.5 h-3.5 rounded" />
                                                    </>
                                                )}
                                                <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" />
                                            </div>
                                        </DropdownMenuItem>
                                    </TooltipTrigger>
                                    <TooltipContent side="left" className="text-xs max-w-xs">
                                        <p>Open integrations</p>
                                    </TooltipContent>
                                </Tooltip>
                            </TooltipProvider>
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
                            className="h-8 px-2 bg-transparent border-0 rounded-xl text-muted-foreground hover:text-foreground hover:bg-accent/50 flex items-center gap-1.5 cursor-not-allowed opacity-80 pointer-events-none"
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


