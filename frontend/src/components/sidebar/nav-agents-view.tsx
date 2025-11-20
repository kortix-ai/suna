'use client';

import { useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { Plus, MoreHorizontal, Trash2, ExternalLink } from 'lucide-react';
import { useSidebar } from '@/components/ui/sidebar';
import { useAgents, useDeleteAgent } from '@/hooks/agents/use-agents';
import { cn } from '@/lib/utils';
import { SpotlightCard } from '@/components/ui/spotlight-card';
import { formatDateForList } from '@/lib/utils/date-formatting';
import { Button } from '@/components/ui/button';
import { AgentAvatar } from '@/components/thread/content/agent-avatar';
import { NewAgentDialog } from '@/components/agents/new-agent-dialog';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { DeleteConfirmationDialog } from "@/components/thread/DeleteConfirmationDialog";
import { toast } from "sonner";
import { useQueryClient } from '@tanstack/react-query';
import { agentKeys } from '@/hooks/agents/keys';

// Component for date group headers (reusing the style from nav-agents)
const DateGroupHeader: React.FC<{ title: string; count: number }> = ({ title, count }) => {
    return (
        <div className="py-2 mt-4 first:mt-2">
            <div className="text-xs font-medium text-muted-foreground pl-2.5">
                {title}
            </div>
        </div>
    );
};

// Component for individual agent item
const AgentItem: React.FC<{
    agent: any;
    isActive: boolean;
    onAgentClick: (agentId: string) => void;
    handleDeleteAgent: (agentId: string, agentName: string) => void;
}> = ({ agent, isActive, onAgentClick, handleDeleteAgent }) => {
    const [isHoveringCard, setIsHoveringCard] = useState(false);

    return (
        <SpotlightCard
            className={cn(
                "transition-colors cursor-pointer",
                isActive ? "bg-muted" : "bg-transparent"
            )}
        >
            <div
                className="flex items-center gap-3 p-2.5 text-sm"
                onClick={() => onAgentClick(agent.agent_id)}
                onMouseEnter={() => setIsHoveringCard(true)}
                onMouseLeave={() => setIsHoveringCard(false)}
            >
                <div className="flex-shrink-0">
                    <AgentAvatar
                        agent={agent}
                        agentId={agent.agent_id}
                        size={40}
                    />
                </div>
                <span className="flex-1 truncate">{agent.name}</span>
                <div className="flex-shrink-0 relative">
                    <span
                        className={cn(
                            "text-xs text-muted-foreground transition-opacity",
                            isHoveringCard ? "opacity-0" : "opacity-100"
                        )}
                    >
                        {formatDateForList(agent.updated_at || agent.created_at)}
                    </span>
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <button
                                className={cn(
                                    "absolute top-1/2 right-0 -translate-y-1/2 p-1 rounded-md hover:bg-accent transition-all text-muted-foreground",
                                    isHoveringCard ? "opacity-100" : "opacity-0 pointer-events-none"
                                )}
                                onClick={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                }}
                            >
                                <MoreHorizontal className="h-4 w-4 rotate-90" />
                            </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-48">
                            <DropdownMenuItem
                                onClick={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    window.open(`/agents/config/${agent.agent_id}`, '_blank');
                                }}
                            >
                                <ExternalLink className="mr-2 h-4 w-4" />
                                Open in new tab
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                                onClick={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    handleDeleteAgent(agent.agent_id, agent.name);
                                }}
                            >
                                <Trash2 className="mr-2 h-4 w-4" />
                                Delete
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                </div>
            </div>
        </SpotlightCard>
    );
};

export function NavAgentsView() {
    const { isMobile, state, setOpenMobile } = useSidebar();
    const router = useRouter();
    const pathname = usePathname();
    const queryClient = useQueryClient();

    const [showNewAgentDialog, setShowNewAgentDialog] = useState(false);
    const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
    const [agentToDelete, setAgentToDelete] = useState<{ id: string; name: string } | null>(null);

    const {
        data: agentsResponse,
        isLoading: isAgentsLoading,
        error: agentsError
    } = useAgents({
        limit: 50, // Changed from 100 to 50 to match other components
        sort_by: 'updated_at',
        sort_order: 'desc'
    });

    const { mutate: deleteAgentMutation, isPending: isDeleting } = useDeleteAgent();

    const agents = agentsResponse?.agents || [];

    const handleAgentClick = (agentId: string) => {
        router.push(`/agents/config/${agentId}`);
        if (isMobile) {
            setOpenMobile(false);
        }
    };

    const handleDeleteAgent = (agentId: string, agentName: string) => {
        setAgentToDelete({ id: agentId, name: agentName });
        setIsDeleteDialogOpen(true);
    };

    const confirmDelete = async () => {
        if (!agentToDelete) return;

        setIsDeleteDialogOpen(false);

        const agentId = agentToDelete.id;
        const isActive = pathname?.includes(agentId);

        deleteAgentMutation(agentId, {
            onSuccess: () => {
                queryClient.invalidateQueries({ queryKey: agentKeys.lists() });
                toast.success('Worker deleted successfully');

                // Navigate away if we're on the deleted agent's page
                if (isActive) {
                    router.push('/agents');
                }
            },
            onSettled: () => {
                setAgentToDelete(null);
            }
        });
    };

    return (
        <div>
            <div className="overflow-y-auto max-h-[calc(100vh-280px)] [&::-webkit-scrollbar]:hidden [-ms-overflow-style:'none'] [scrollbar-width:'none'] pb-32">
                {(state !== 'collapsed' || isMobile) && (
                    <>
                        {/* Always show header */}
                        <DateGroupHeader title="My Workforce" count={agents.length} />

                        {isAgentsLoading ? (
                            // Show skeleton loaders while loading
                            <div className="space-y-1">
                                {Array.from({ length: 3 }).map((_, index) => (
                                    <div key={`skeleton-${index}`} className="flex items-center gap-3 px-2 py-2">
                                        <div className="h-10 w-10 bg-muted/10 border-[1.5px] border-border rounded-2xl animate-pulse"></div>
                                        <div className="h-4 bg-muted rounded flex-1 animate-pulse"></div>
                                        <div className="h-3 w-8 bg-muted rounded animate-pulse"></div>
                                    </div>
                                ))}
                            </div>
                        ) : agents.length > 0 ? (
                            // Show agents list
                            <>
                                {agents.map((agent) => {
                                    const isActive = pathname?.includes(agent.agent_id) || false;
                                    return (
                                        <AgentItem
                                            key={agent.agent_id}
                                            agent={agent}
                                            isActive={isActive}
                                            onAgentClick={handleAgentClick}
                                            handleDeleteAgent={handleDeleteAgent}
                                        />
                                    );
                                })}
                            </>
                        ) : (
                            <div className="py-2 px-2 text-sm text-muted-foreground">
                            </div>
                        )}
                        <Button
                            variant="outline"
                            size="sm"
                            className="w-full shadow-none justify-center items-center h-10 px-4 bg-background mt-3"
                            onClick={() => setShowNewAgentDialog(true)}
                        >
                            <div className="flex items-center gap-2">
                                <Plus className="h-4 w-4" />
                                Add Workers
                            </div>
                        </Button>
                    </>
                )}
            </div>

            <NewAgentDialog
                open={showNewAgentDialog}
                onOpenChange={setShowNewAgentDialog}
                onSuccess={(agentId) => {
                    router.push(`/agents/config/${agentId}`);
                    if (isMobile) setOpenMobile(false);
                }}
            />

            {agentToDelete && (
                <DeleteConfirmationDialog
                    isOpen={isDeleteDialogOpen}
                    onClose={() => setIsDeleteDialogOpen(false)}
                    onConfirm={confirmDelete}
                    threadName={agentToDelete.name}
                    isDeleting={isDeleting}
                />
            )}
        </div>
    );
}