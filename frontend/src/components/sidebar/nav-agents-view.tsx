'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Bot, Loader2 } from 'lucide-react';
import { useSidebar } from '@/components/ui/sidebar';
import { useAgents } from '@/hooks/react-query/agents/use-agents';
import Link from 'next/link';
import { cn } from '@/lib/utils';
import { SpotlightCard } from '@/components/ui/spotlight-card';

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
}> = ({ agent, isActive, onAgentClick }) => {
    const formatDate = (dateString: string) => {
        const date = new Date(dateString);
        const now = new Date();
        const diffDays = Math.floor((now.getTime() - date.getTime()) / (1000 * 3600 * 24));

        if (diffDays === 0) return 'Today';
        if (diffDays === 1) return 'Yesterday';
        if (diffDays < 7) return `${diffDays}d`;
        return date.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' });
    };

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
            >
                <div
                    className="flex items-center justify-center w-10 h-10 rounded-2xl border-[1.5px] border-border flex-shrink-0"
                    style={{
                        backgroundColor: agent.icon_background || '#f3f4f6',
                        color: agent.icon_color || '#6b7280'
                    }}
                >
                    <Bot className="h-4 w-4" />
                </div>
                <span className="flex-1 truncate">{agent.name}</span>
                <span className="text-xs text-muted-foreground flex-shrink-0">
                    {formatDate(agent.updated_at || agent.created_at)}
                </span>
            </div>
        </SpotlightCard>
    );
};

export function NavAgentsView() {
    const { isMobile, state, setOpenMobile } = useSidebar();
    const router = useRouter();

    const {
        data: agentsResponse,
        isLoading: isAgentsLoading,
        error: agentsError
    } = useAgents({
        limit: 100,
        sort_by: 'updated_at',
        sort_order: 'desc'
    });

    const agents = agentsResponse?.agents || [];

    const handleAgentClick = (agentId: string) => {
        router.push(`/agents/config/${agentId}`);
        if (isMobile) {
            setOpenMobile(false);
        }
    };

    return (
        <div>
            <div className="overflow-y-auto max-h-[calc(100vh-280px)] [&::-webkit-scrollbar]:hidden [-ms-overflow-style:'none'] [scrollbar-width:'none'] pb-32">
                {(state !== 'collapsed' || isMobile) && (
                    <>
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
                                <DateGroupHeader title="My Workforce" count={agents.length} />
                                {agents.map((agent) => (
                                    <AgentItem
                                        key={agent.agent_id}
                                        agent={agent}
                                        isActive={false} // We can add logic to detect active agent later
                                        onAgentClick={handleAgentClick}
                                    />
                                ))}
                            </>
                        ) : (
                            <div className="py-2 text-sm text-muted-foreground">
                                No agents yet
                            </div>
                        )}
                    </>
                )}
            </div>
        </div>
    );
}