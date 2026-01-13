'use client';

import { useState, useMemo, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, Search, Frown, ChevronRight } from 'lucide-react';
import { useAgents } from '@/hooks/agents/use-agents';
import { AgentAvatar } from '@/components/thread/content/agent-avatar';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { NewAgentDialog } from '@/components/agents/new-agent-dialog';
import { KortixLoader } from '@/components/ui/kortix-loader';
import { useSidebar } from '@/components/ui/sidebar';
import { useIsMobile } from '@/hooks/utils';
import { usePricingModalStore } from '@/stores/pricing-modal-store';
import { useAccountState, accountStateSelectors } from '@/hooks/billing';
import { isLocalMode } from '@/lib/config';
import { Sparkles } from 'lucide-react';

export function NavWorkers() {
  const router = useRouter();
  const { setOpenMobile } = useSidebar();
  const isMobile = useIsMobile();
  const [searchQuery, setSearchQuery] = useState('');
  const [showNewAgentDialog, setShowNewAgentDialog] = useState(false);
  const { openPricingModal } = usePricingModalStore();
  const { data: accountState } = useAccountState();
  
  const tierKey = accountStateSelectors.tierKey(accountState);
  const isFreeTier = tierKey && (
    tierKey === 'free' ||
    tierKey === 'none'
  ) && !isLocalMode();

  const { data: agentsResponse, isLoading } = useAgents({ limit: 50 });
  const agents = useMemo(() => {
    return Array.isArray(agentsResponse?.agents) ? agentsResponse.agents : [];
  }, [agentsResponse]);

  const filteredAgents = useMemo(() => {
    if (!searchQuery.trim()) return agents;
    const query = searchQuery.toLowerCase();
    return agents.filter(agent => 
      agent.name?.toLowerCase().includes(query)
    );
  }, [agents, searchQuery]);

  const sunaAgent = useMemo(() => {
    return agents.find(a => a.metadata?.is_suna_default === true);
  }, [agents]);

  const customAgents = useMemo(() => {
    return filteredAgents.filter(a => !a.metadata?.is_suna_default);
  }, [filteredAgents]);

  const handleAgentClick = useCallback((agentId: string) => {
    router.push(`/agents/config/${agentId}`);
    if (isMobile) {
      setOpenMobile(false);
    }
  }, [router, isMobile, setOpenMobile]);

  const handleCreateWorker = () => {
    if (isFreeTier) {
      openPricingModal();
    } else {
      setShowNewAgentDialog(true);
    }
  };

  return (
    <div className="flex flex-col h-full pt-4">
      <div className="relative mb-3">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
        <input
          type="text"
          placeholder="Search workers..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-full h-10 pl-9 pr-3 rounded-xl text-sm bg-muted/50 border border-border focus:outline-none focus:ring-2 focus:ring-primary/50"
        />
      </div>

      <div className="flex-1 overflow-y-auto space-y-1 [&::-webkit-scrollbar]:hidden [-ms-overflow-style:'none'] [scrollbar-width:'none']">
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <KortixLoader size="small" />
          </div>
        ) : filteredAgents.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <div className="w-12 h-12 bg-muted/50 rounded-2xl flex items-center justify-center mb-3">
              <Frown className="h-6 w-6 text-muted-foreground" />
            </div>
            <p className="text-sm text-muted-foreground">
              {searchQuery ? 'No workers found' : 'No workers yet'}
            </p>
          </div>
        ) : (
          <>
            {sunaAgent && !searchQuery && (
              <div
                className={cn(
                  "flex items-center gap-3 p-2.5 rounded-xl cursor-pointer transition-colors",
                  "hover:bg-muted/50"
                )}
                onClick={() => handleAgentClick(sunaAgent.agent_id)}
              >
                <AgentAvatar 
                  agent={sunaAgent} 
                  agentId={sunaAgent.agent_id} 
                  size={32} 
                  className="flex-shrink-0"
                />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate">{sunaAgent.name}</div>
                  <div className="text-xs text-muted-foreground truncate">Default agent</div>
                </div>
                <ChevronRight className="h-4 w-4 text-muted-foreground flex-shrink-0" />
              </div>
            )}

            {customAgents.length > 0 && (
              <div className="pt-2">
                {!searchQuery && (
                  <div className="text-xs font-medium text-muted-foreground px-2.5 pb-2">
                    My Workers
                  </div>
                )}
                {customAgents.map((agent) => (
                  <div
                    key={agent.agent_id}
                    className={cn(
                      "flex items-center gap-3 p-2.5 rounded-xl cursor-pointer transition-colors mb-1",
                      "hover:bg-muted/50"
                    )}
                    onClick={() => handleAgentClick(agent.agent_id)}
                  >
                    <AgentAvatar 
                      agent={agent} 
                      agentId={agent.agent_id} 
                      size={32} 
                      className="flex-shrink-0"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate">{agent.name}</div>
                    </div>
                    <ChevronRight className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      <div className="pt-3 border-t border-border/50 mt-3">
        <Button
          variant="outline"
          size="sm"
          className="w-full justify-start gap-2 h-10"
          onClick={handleCreateWorker}
        >
          {isFreeTier ? (
            <>
              <Sparkles className="h-4 w-4 text-primary" />
              <span className="text-primary">Create Worker</span>
            </>
          ) : (
            <>
              <Plus className="h-4 w-4" />
              <span>Create Worker</span>
            </>
          )}
        </Button>
      </div>

      <NewAgentDialog
        open={showNewAgentDialog}
        onOpenChange={setShowNewAgentDialog}
      />
    </div>
  );
}
