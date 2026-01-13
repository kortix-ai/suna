'use client';

import React, { useEffect, useMemo, useRef, useState, useCallback, memo } from 'react';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuTrigger,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
    DropdownMenuPortal,
} from '@/components/ui/dropdown-menu';
import {
    Sheet,
    SheetContent,
    SheetHeader,
    SheetTitle,
} from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Search, Check, ChevronDown, Plus, Plug, Brain, LibraryBig, Zap, Sparkles, ChevronLeft } from 'lucide-react';
import { KortixLoader } from '@/components/ui/kortix-loader';
import { useAgents } from '@/hooks/agents/use-agents';
import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { SpotlightCard } from '@/components/ui/spotlight-card';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { IntegrationsRegistry } from '@/components/agents/integrations-registry';
import { useTranslations } from 'next-intl';
import { NewAgentDialog } from '@/components/agents/new-agent-dialog';
import { AgentAvatar } from '@/components/thread/content/agent-avatar';
import { AgentConfigurationDialog } from '@/components/agents/agent-configuration-dialog';
import { usePricingModalStore } from '@/stores/pricing-modal-store';
import { useAccountState, accountStateSelectors } from '@/hooks/billing';
import { isLocalMode } from '@/lib/config';
import { VisuallyHidden } from '@radix-ui/react-visually-hidden';



type UnifiedConfigMenuProps = {
    isLoggedIn?: boolean;

    // Agent
    selectedAgentId?: string;
    onAgentSelect?: (agentId: string | undefined) => void;
};

const LoggedInMenu: React.FC<UnifiedConfigMenuProps> = memo(function LoggedInMenu({
    isLoggedIn = true,
    selectedAgentId,
    onAgentSelect,
}) {
    const t = useTranslations('thread');
    const [isOpen, setIsOpen] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');
    const [debouncedSearchQuery, setDebouncedSearchQuery] = useState('');
    const [currentPage, setCurrentPage] = useState(1);
    const [allAgents, setAllAgents] = useState<any[]>([]);
    const [integrationsOpen, setIntegrationsOpen] = useState(false);
    const [showNewAgentDialog, setShowNewAgentDialog] = useState(false);
    const searchInputRef = useRef<HTMLInputElement>(null);
    const [agentConfigDialog, setAgentConfigDialog] = useState<{ open: boolean; tab: 'instructions' | 'knowledge' | 'triggers' | 'tools' | 'integrations' }>({ open: false, tab: 'instructions' });
    const { data: accountState } = useAccountState();
    const { openPricingModal } = usePricingModalStore();
    const [isMobile, setIsMobile] = useState(false);
    const [mobileSection, setMobileSection] = useState<'main' | 'agents'>('main');

    const tierKey = accountStateSelectors.tierKey(accountState);
    const isFreeTier = tierKey && (
      tierKey === 'free' ||
      tierKey === 'none'
    ) && !isLocalMode();

    // Detect mobile view
    useEffect(() => {
        const checkMobile = () => {
            setIsMobile(window.innerWidth < 640);
        };

        checkMobile();
        window.addEventListener('resize', checkMobile);
        return () => window.removeEventListener('resize', checkMobile);
    }, []);

    // Debounce search query
    useEffect(() => {
        const timer = setTimeout(() => {
            setDebouncedSearchQuery(searchQuery);
            setCurrentPage(1);
        }, 300);
        return () => clearTimeout(timer);
    }, [searchQuery]);

    const agentsParams = useMemo(() => ({
        page: currentPage > 1 ? currentPage : undefined,
        limit: 50,
        search: debouncedSearchQuery || undefined,
    }), [currentPage, debouncedSearchQuery]);

    const { data: agentsResponse, isLoading, isFetching } = useAgents(agentsParams, { enabled: isLoggedIn });

    useEffect(() => {
        if (Array.isArray(agentsResponse?.agents)) {
            if (currentPage === 1 || debouncedSearchQuery) {
                setAllAgents(agentsResponse.agents);
            } else {
                setAllAgents(prev => [...prev, ...agentsResponse.agents]);
            }
        }
    }, [agentsResponse, currentPage, debouncedSearchQuery]);

    const agents: any[] = allAgents;

    const sunaAgent = useMemo(() => {
        return agents.find(a => a.metadata?.is_suna_default === true);
    }, [agents]);

    const placeholderSunaAgent = useMemo(() => ({
        agent_id: undefined,
        name: 'Kortix',
        metadata: { is_suna_default: true }
    }), []);

    useEffect(() => {
        if (isOpen && !isMobile) {
            setTimeout(() => searchInputRef.current?.focus(), 30);
        } else if (!isOpen) {
            setSearchQuery('');
            setDebouncedSearchQuery('');
            setCurrentPage(1);
            setMobileSection('main');
        }
    }, [isOpen, isMobile]);

    useEffect(() => {
        if (isOpen && !isMobile) searchInputRef.current?.focus();
    }, [searchQuery, isOpen, isMobile]);

    const handleSearchInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        e.stopPropagation();
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
        }
    };

    const orderedAgents = useMemo(() => {
        const list = [...agents];
        const selected = selectedAgentId ? list.find(a => a.agent_id === selectedAgentId) : undefined;
        const rest = selected ? list.filter(a => a.agent_id !== selectedAgentId) : list;
        return selected ? [selected, ...rest] : rest;
    }, [agents, selectedAgentId]);

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
        if (selectedAgentId) {
            const found = agents.find(a => a.agent_id === selectedAgentId);
            if (found) return found;
        }
        if (sunaAgent) return sunaAgent;
        return agents[0];
    }, [agents, selectedAgentId, sunaAgent]);

    const handleQuickAction = useCallback((action: 'instructions' | 'knowledge' | 'triggers' | 'tools') => {
        if (!selectedAgentId && !displayAgent?.agent_id) {
            return;
        }
        setAgentConfigDialog({ open: true, tab: action });
        setIsOpen(false);
    }, [selectedAgentId, displayAgent?.agent_id]);

    const renderAgentIcon = useCallback((agent: any, size: number = 32) => {
        if (!agent && (isLoading || sunaAgent)) {
            return <AgentAvatar isSunaDefault={true} agentName="Kortix" size={size} className="flex-shrink-0 !border-0" />;
        }
        return <AgentAvatar agent={agent} agentId={agent?.agent_id} size={size} className="flex-shrink-0 !border-0" />;
    }, [isLoading, sunaAgent]);

    // Shared content components
    const AgentsList = useCallback(({ compact = false }: { compact?: boolean }) => (
        <>
            {isLoading && orderedAgents.length === 0 ? (
                <div className={cn("space-y-2", compact ? "px-2" : "px-3")}>
                    {Array.from({ length: 3 }).map((_, i) => (
                        <div key={i} className="flex items-center gap-3 p-2 sm:p-3 rounded-xl sm:rounded-2xl">
                            <div className="h-9 w-9 sm:h-8 sm:w-8 bg-muted/60 border-[1.5px] border-border rounded-xl sm:rounded-2xl animate-pulse"></div>
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
                    <div className={cn(
                        "overflow-y-auto space-y-1 sm:space-y-0.5",
                        compact ? "max-h-[340px] px-2" : "max-h-[50vh] px-3",
                        "[&::-webkit-scrollbar]:hidden [-ms-overflow-style:'none'] [scrollbar-width:'none']"
                    )}>
                        {orderedAgents.map((agent) => {
                            const isActive = selectedAgentId === agent.agent_id;
                            return (
                                <div
                                    key={agent.agent_id}
                                    className={cn(
                                        "flex items-center gap-3 text-sm cursor-pointer rounded-xl sm:rounded-2xl transition-colors",
                                        compact ? "px-2 py-2" : "px-3 py-3 sm:py-2",
                                        isActive ? "bg-primary/5" : "hover:bg-muted/50 active:bg-muted/70"
                                    )}
                                    onClick={() => handleAgentClick(agent.agent_id)}
                                >
                                    <div className={cn(
                                        "flex items-center justify-center bg-transparent border-[1.5px] border-border flex-shrink-0",
                                        compact ? "w-8 h-8" : "w-10 h-10 sm:w-8 sm:h-8"
                                    )} style={{ borderRadius: '10.4px' }}>
                                        {renderAgentIcon(agent, compact ? 32 : (isMobile ? 40 : 32))}
                                    </div>
                                    <span className={cn(
                                        "flex-1 truncate font-medium",
                                        compact ? "text-sm" : "text-base sm:text-sm"
                                    )}>{agent.name}</span>
                                    {isActive && (
                                        <Check className={cn(
                                            "text-primary flex-shrink-0",
                                            compact ? "h-4 w-4" : "h-5 w-5 sm:h-4 sm:w-4"
                                        )} />
                                    )}
                                </div>
                            );
                        })}
                    </div>
                    {canLoadMore && (
                        <div className={cn("pt-2", compact ? "px-2" : "px-3")}>
                            <Button
                                size="sm"
                                variant="ghost"
                                className={cn(
                                    "w-full text-sm text-muted-foreground hover:text-foreground rounded-2xl hover:bg-muted/60",
                                    compact ? "h-8" : "h-10 sm:h-8"
                                )}
                                onClick={handleLoadMore}
                                disabled={isFetching}
                            >
                                {isFetching ? (
                                    <>
                                        <KortixLoader size="small" className="mr-2" />
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
        </>
    ), [orderedAgents, isLoading, debouncedSearchQuery, selectedAgentId, handleAgentClick, renderAgentIcon, canLoadMore, handleLoadMore, isFetching, isMobile]);

    const CreateWorkerButton = useCallback(({ compact = false }: { compact?: boolean }) => (
        <div className={cn(
            "border-t border-border/50 mt-2",
            compact ? "px-2 pt-2 pb-1" : "px-3 pt-3 pb-2"
        )}>
            <div
                className={cn(
                    "flex items-center gap-3 text-sm cursor-pointer rounded-xl sm:rounded-2xl transition-colors",
                    compact ? "px-2 py-2" : "px-3 py-3 sm:py-2",
                    "hover:bg-muted/50 active:bg-muted/70"
                )}
                onClick={() => {
                    setIsOpen(false);
                    if (isFreeTier) {
                        openPricingModal();
                    } else {
                        setShowNewAgentDialog(true);
                    }
                }}
            >
                <div className={cn(
                    "flex items-center justify-center border-[1.5px] flex-shrink-0 transition-colors",
                    compact ? "w-8 h-8" : "w-10 h-10 sm:w-8 sm:h-8",
                    isFreeTier
                        ? "bg-primary/10 border-primary/30"
                        : "bg-card border-border"
                )} style={{ borderRadius: '10.4px' }}>
                    {isFreeTier ? (
                        <Sparkles className={cn(
                            "text-primary",
                            compact ? "h-4 w-4" : "h-5 w-5 sm:h-4 sm:w-4"
                        )} />
                    ) : (
                        <Plus className={cn(
                            "text-muted-foreground",
                            compact ? "h-4 w-4" : "h-5 w-5 sm:h-4 sm:w-4"
                        )} />
                    )}
                </div>
                <div className="flex-1 min-w-0">
                    <span className={cn(
                        "font-medium",
                        compact ? "text-sm" : "text-base sm:text-sm",
                        isFreeTier ? "text-primary" : "text-foreground"
                    )}>
                        Create AI Worker
                    </span>
                    {isFreeTier && (
                        <p className={cn(
                            "text-muted-foreground leading-tight mt-0.5",
                            compact ? "text-[10px]" : "text-xs sm:text-[10px]"
                        )}>
                            Upgrade to create custom workers
                        </p>
                    )}
                </div>
            </div>
        </div>
    ), [isFreeTier, openPricingModal]);

    const WorkerSettingsButtons = useCallback(({ compact = false }: { compact?: boolean }) => (
        onAgentSelect && (selectedAgentId || displayAgent?.agent_id) ? (
            <div className={compact ? "px-3" : "px-4 sm:px-3"}>
                <div className="mb-2 sm:mb-3">
                    <span className="text-xs font-medium text-muted-foreground">Worker Settings</span>
                </div>
                <div className="flex items-center gap-2">
                    {[
                        { action: 'instructions' as const, icon: Plug, label: 'Instructions' },
                        { action: 'knowledge' as const, icon: Brain, label: 'Knowledge' },
                        { action: 'integrations' as const, icon: LibraryBig, label: 'Integrations' },
                        { action: 'triggers' as const, icon: Zap, label: 'Triggers' },
                    ].map(({ action, icon: Icon, label }) => (
                        <Tooltip key={action}>
                            <TooltipTrigger asChild>
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    className={cn(
                                        "flex-1 p-0 cursor-pointer hover:bg-muted/60 border-[1.5px] border-border rounded-2xl",
                                        compact ? "h-8" : "h-11 sm:h-8"
                                    )}
                                    onClick={() => {
                                        setIsOpen(false);
                                        if (action === 'integrations') {
                                            setIntegrationsOpen(true);
                                        } else {
                                            handleQuickAction(action as any);
                                        }
                                    }}
                                >
                                    <Icon className={cn(
                                        compact ? "h-4 w-4" : "h-5 w-5 sm:h-4 sm:w-4"
                                    )} />
                                </Button>
                            </TooltipTrigger>
                            <TooltipContent side="bottom" className="text-xs">
                                {label}
                            </TooltipContent>
                        </Tooltip>
                    ))}
                </div>
            </div>
        ) : null
    ), [onAgentSelect, selectedAgentId, displayAgent?.agent_id, handleQuickAction]);

    // Check if current agent is Kortix (used in multiple places)
    const isKortixAgent = !displayAgent?.name || displayAgent?.name === 'Kortix';

    // Mobile Sheet Content
    const MobileSheetContent = useCallback(() => {
        if (mobileSection === 'agents') {
            return (
                <div className="flex flex-col h-full">
                    {/* Header */}
                    <div className="flex items-center gap-3 px-4 py-3 border-b border-border">
                        <button
                            onClick={() => setMobileSection('main')}
                            className="p-2 -ml-2 hover:bg-muted/50 rounded-2xl transition-colors"
                        >
                            <ChevronLeft className="h-5 w-5 text-muted-foreground" />
                        </button>
                        <span className="text-base font-semibold">Select Worker</span>
                    </div>

                    {/* Search */}
                    <div className="px-4 py-3">
                        <div className="relative">
                            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground pointer-events-none" />
                            <input
                                type="text"
                                placeholder="Search workers..."
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                                className="w-full h-12 pl-11 pr-4 rounded-xl text-base font-medium bg-muted/50 border border-border focus:outline-none focus:ring-2 focus:ring-primary/50"
                                autoFocus
                            />
                        </div>
                    </div>

                    {/* List */}
                    <div className="flex-1 overflow-hidden">
                        <div className="px-4 pb-2">
                            <span className="text-xs font-medium text-muted-foreground">My Workers</span>
                        </div>
                        <AgentsList compact={false} />
                        <CreateWorkerButton compact={false} />
                    </div>
                </div>
            );
        }

        // Main section
        return (
            <div className="flex flex-col">
                {/* Handle bar */}
                <div className="flex justify-center pt-3 pb-2">
                    <div className="w-10 h-1 rounded-full bg-muted-foreground/30" />
                </div>

                {/* Agent selector */}
                {onAgentSelect && (
                    <>
                        <div className="px-4 pt-1 pb-1">
                            <span className="text-xs font-medium text-muted-foreground">Worker</span>
                        </div>
                        <div className="px-4 pb-2">
                            <button
                                onClick={() => setMobileSection('agents')}
                                className="w-full flex items-center gap-3 p-3 rounded-2xl border border-border bg-card hover:bg-muted/50 active:bg-muted/70 transition-colors"
                            >
                                {isKortixAgent ? (
                                    <div className="flex items-center justify-center w-10 h-10 bg-card border-[1.5px] border-border flex-shrink-0" style={{ borderRadius: '10.4px' }}>
                                        {renderAgentIcon(null, 40)}
                                    </div>
                                ) : (
                                    <div className="flex items-center justify-center w-10 h-10 bg-card border-[1.5px] border-border flex-shrink-0" style={{ borderRadius: '10.4px' }}>
                                        {renderAgentIcon(isLoading && !displayAgent ? placeholderSunaAgent : displayAgent, 40)}
                                    </div>
                                )}
                                <span className="flex-1 truncate text-base font-medium text-left min-w-0">
                                    {isKortixAgent ? 'Kortix' : displayAgent?.name}
                                </span>
                                <ChevronDown className="h-5 w-5 text-muted-foreground rotate-[-90deg] flex-shrink-0" />
                            </button>
                        </div>
                    </>
                )}

                {/* Worker settings */}
                {onAgentSelect && (selectedAgentId || displayAgent?.agent_id) && (
                    <div className="py-3">
                        <WorkerSettingsButtons compact={false} />
                    </div>
                )}
            </div>
        );
    }, [mobileSection, searchQuery, onAgentSelect, displayAgent, isLoading, placeholderSunaAgent, renderAgentIcon, selectedAgentId, AgentsList, CreateWorkerButton, WorkerSettingsButtons, isKortixAgent]);

    // Trigger button
    const TriggerButton = (
        <Button
            variant="ghost"
            size="sm"
            className="h-10 px-2 bg-transparent border-[1.5px] border-border rounded-2xl text-muted-foreground hover:text-foreground hover:bg-accent/50 flex items-center gap-1.5"
            aria-label="Config menu"
            onClick={() => setIsOpen(true)}
        >
            {onAgentSelect ? (
                <div className="flex items-center gap-2 min-w-0 max-w-[180px]">
                    {isKortixAgent ? (
                        <KortixLogo variant="logomark" size={14} />
                    ) : (
                        <>
                            {renderAgentIcon(isLoading && !displayAgent ? placeholderSunaAgent : displayAgent, 24)}
                            <span className="truncate text-sm font-medium">
                                {displayAgent?.name}
                            </span>
                        </>
                    )}
                    <ChevronDown size={12} className="opacity-60 flex-shrink-0" />
                </div>
            ) : (
                <div className="flex items-center gap-1.5">
                    <KortixLogo size={20} />
                    <ChevronDown size={12} className="opacity-60" />
                </div>
            )}
        </Button>
    );

    return (
        <>
            {/* Mobile: Use Sheet */}
            {isMobile ? (
                <>
                    <Tooltip>
                        <TooltipTrigger asChild>
                            {TriggerButton}
                        </TooltipTrigger>
                        <TooltipContent side="top">
                            <p>Worker settings</p>
                        </TooltipContent>
                    </Tooltip>
                    <Sheet open={isOpen} onOpenChange={setIsOpen}>
                        <SheetContent
                            side="bottom"
                            className={cn(
                                "rounded-t-2xl px-0 pb-8",
                                mobileSection === 'main' ? "max-h-[70vh]" : "h-[85vh]"
                            )}
                        >
                            <VisuallyHidden>
                                <SheetHeader>
                                    <SheetTitle>Configuration</SheetTitle>
                                </SheetHeader>
                            </VisuallyHidden>
                            <MobileSheetContent />
                        </SheetContent>
                    </Sheet>
                </>
            ) : (
                /* Desktop: Use Dropdown */
                <DropdownMenu open={isOpen} onOpenChange={setIsOpen}>
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <DropdownMenuTrigger asChild>
                                {TriggerButton}
                            </DropdownMenuTrigger>
                        </TooltipTrigger>
                        <TooltipContent side="top">
                            <p>Worker settings</p>
                        </TooltipContent>
                    </Tooltip>

                    <DropdownMenuContent align="end" className="w-[320px] px-0 py-3 border-[1.5px] border-border rounded-2xl" sideOffset={6}>
                        <TooltipProvider>
                            {/* Agents Submenu */}
                            {onAgentSelect && (
                                <>
                                    <div className="px-3 pb-1">
                                        <span className="text-xs font-medium text-muted-foreground">Worker</span>
                                    </div>
                                    <div className="px-2 pb-2">
                                        <SpotlightCard className={cn("transition-colors cursor-pointer bg-transparent", isKortixAgent ? "p-2" : "")}>
                                            <DropdownMenuSub>
                                                <DropdownMenuSubTrigger className="flex items-center gap-3 text-sm cursor-pointer px-1 hover:bg-transparent focus:bg-transparent data-[state=open]:bg-transparent w-full">
                                                    {isKortixAgent ? (
                                                        <KortixLogo variant="logomark" size={14} />
                                                    ) : (
                                                        <div className="flex items-center">
                                                            {renderAgentIcon(isLoading && !displayAgent ? placeholderSunaAgent : displayAgent)}
                                                            <span className="flex-1 truncate font-medium text-left">{displayAgent?.name}</span>
                                                        </div>
                                                    )}
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
                                                        </div>
                                                        <AgentsList compact={true} />
                                                        <CreateWorkerButton compact={true} />
                                                    </DropdownMenuSubContent>
                                                </DropdownMenuPortal>
                                            </DropdownMenuSub>
                                        </SpotlightCard>
                                    </div>
                                </>
                            )}

                            <WorkerSettingsButtons compact={true} />
                        </TooltipProvider>
                    </DropdownMenuContent>
                </DropdownMenu>
            )}

            {/* Dialogs */}
            <Dialog open={integrationsOpen} onOpenChange={setIntegrationsOpen}>
                <DialogContent className="p-0 max-w-6xl h-[90vh] sm:h-[90vh] max-h-[100vh] sm:max-h-[90vh] overflow-hidden">
                    <DialogHeader className="sr-only">
                        <DialogTitle>Integrations</DialogTitle>
                    </DialogHeader>
                    <IntegrationsRegistry
                        showAgentSelector={true}
                        selectedAgentId={selectedAgentId}
                        onAgentChange={onAgentSelect}
                        onClose={() => setIntegrationsOpen(false)}
                        isBlocked={isFreeTier}
                        onBlockedClick={() => openPricingModal()}
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
        <Tooltip>
            <TooltipTrigger asChild>
                <span className="inline-block">
                    <Button
                        variant="outline"
                        size="sm"
                        className="h-10 px-2 sm:px-3 py-2 bg-transparent border-[1.5px] border-border rounded-2xl text-muted-foreground hover:text-foreground hover:bg-accent/50 flex items-center gap-1 sm:gap-1.5 cursor-pointer transition-all duration-200 flex-shrink-0 animate-in fade-in-0 zoom-in-95"
                        disabled
                    >
                        <div className="flex items-center gap-2 min-w-0 max-w-[180px]">
                            <div className="flex-shrink-0">
                                <KortixLogo size={20} />
                            </div>
                            <span className="truncate text-sm font-medium">Kortix</span>
                            <ChevronDown size={12} className="opacity-60 flex-shrink-0" />
                        </div>
                    </Button>
                </span>
            </TooltipTrigger>
            <TooltipContent side="top" className="text-xs">
                <p>Log in to change agent</p>
            </TooltipContent>
        </Tooltip>
    );
});

export const UnifiedConfigMenu: React.FC<UnifiedConfigMenuProps> = memo(function UnifiedConfigMenu(props) {
    if (props.isLoggedIn) {
        return <LoggedInMenu {...props} />;
    }
    return <GuestMenu {...props} />;
});

export default UnifiedConfigMenu;
