'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
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
import { Cpu, Search, Check, ChevronDown, Plus, ExternalLink } from 'lucide-react';
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
import { useAgentWorkflows } from '@/hooks/react-query/agents/use-agent-workflows';
import { PlaybookExecuteDialog } from '@/components/playbooks/playbook-execute-dialog';
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

const LoggedInMenu: React.FC<UnifiedConfigMenuProps> = ({
    isLoggedIn = true,
    selectedAgentId,
    onAgentSelect,
    selectedModel,
    onModelChange,
    modelOptions,
    canAccessModel,
    subscriptionStatus,
    onUpgradeRequest,
}) => {
    const [isOpen, setIsOpen] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');
    const searchContainerRef = useRef<HTMLDivElement>(null);
    const [integrationsOpen, setIntegrationsOpen] = useState(false);
    const [showNewAgentDialog, setShowNewAgentDialog] = useState(false);
    const searchInputRef = useRef<HTMLInputElement>(null);
    const [execDialog, setExecDialog] = useState<{ open: boolean; playbook: any | null; agentId: string | null }>({ open: false, playbook: null, agentId: null });
    const [agentConfigDialog, setAgentConfigDialog] = useState<{ open: boolean; tab: 'general' | 'instructions' | 'knowledge' | 'triggers' | 'playbooks' | 'tools' | 'integrations' }>({ open: false, tab: 'general' });

    const { data: agentsResponse } = useAgents({}, { enabled: isLoggedIn });
    const agents: any[] = agentsResponse?.agents || [];



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

    // Filtered agents with selected first
    const filteredAgents = useMemo(() => {
        const list = [...agents];
        const selected = selectedAgentId ? list.find(a => a.agent_id === selectedAgentId) : undefined;
        const rest = selected ? list.filter(a => a.agent_id !== selectedAgentId) : list;
        const ordered = selected ? [selected, ...rest] : rest;
        return ordered.filter(a => (
            a?.name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
            a?.description?.toLowerCase().includes(searchQuery.toLowerCase())
        ));
    }, [agents, selectedAgentId, searchQuery]);

    // Top 3 slice
    const topAgents = useMemo(() => filteredAgents.slice(0, 3), [filteredAgents]);





    const handleAgentClick = (agentId: string | undefined) => {
        onAgentSelect?.(agentId);
        setIsOpen(false);
    };

    const handleQuickAction = (action: 'instructions' | 'knowledge' | 'triggers' | 'playbooks') => {
        if (!selectedAgentId && !displayAgent?.agent_id) {
            return;
        }
        setAgentConfigDialog({ open: true, tab: action });
        setIsOpen(false);
    };



    const renderAgentIcon = (agent: any) => {
        return <AgentAvatar agentId={agent?.agent_id} size={20} className="flex-shrink-0" fallbackName={agent?.name} />;
    };

    const displayAgent = useMemo(() => {
        const found = agents.find(a => a.agent_id === selectedAgentId) || agents[0];
        return found;
    }, [agents, selectedAgentId]);

    const currentAgentIdForPlaybooks = isLoggedIn ? displayAgent?.agent_id || '' : '';
    const { data: playbooks = [], isLoading: playbooksLoading } = useAgentWorkflows(currentAgentIdForPlaybooks);
    const [playbooksExpanded, setPlaybooksExpanded] = useState(true);

    return (
        <>
            {/* Reusable list of workflows to avoid re-fetch storms; each instance fetches scoped to agentId */}

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
                                    {displayAgent?.name || 'Kusor'}
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
                            {topAgents.length === 0 ? (
                                <div className="px-3 py-2 text-xs text-muted-foreground">No agents</div>
                            ) : (
                                <div className="max-h-[132px] overflow-y-auto">
                                    {filteredAgents.map((agent) => (
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
                            )}

                            {/* Agents "see all" removed; scroll container shows all */}
                            {/* Playbooks moved below (as hover submenu) */}
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
                            <DropdownMenuItem
                                className="text-sm px-3 py-2 mx-0 my-0.5 flex items-center gap-2 cursor-pointer rounded-lg"
                                onClick={() => handleQuickAction('playbooks')}
                            >
                                <span className="font-medium">Playbooks</span>
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
            <PlaybookExecuteDialog
                open={execDialog.open}
                onOpenChange={(open) => setExecDialog((s) => ({ ...s, open }))}
                playbook={execDialog.playbook as any}
                agentId={execDialog.agentId || ''}
            />
            {(selectedAgentId || displayAgent?.agent_id) && (
                <AgentConfigurationDialog
                    open={agentConfigDialog.open}
                    onOpenChange={(open) => setAgentConfigDialog({ ...agentConfigDialog, open })}
                    agentId={selectedAgentId || displayAgent?.agent_id}
                    initialTab={agentConfigDialog.tab}
                />
            )}

        </>
    );
};

const GuestMenu: React.FC<UnifiedConfigMenuProps> = () => {
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
                                <span className="truncate text-sm font-medium">Kusor</span>
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
};

export const UnifiedConfigMenu: React.FC<UnifiedConfigMenuProps> = (props) => {
    if (props.isLoggedIn) {
        return <LoggedInMenu {...props} />;
    }
    return <GuestMenu {...props} />;
};

export default UnifiedConfigMenu;


