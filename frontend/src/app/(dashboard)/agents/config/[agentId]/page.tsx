'use client';

import React, { useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useAgent } from '@/hooks/react-query/agents/use-agents';
import { ChevronLeft, Brain, BookOpen, Zap, Wrench, Server, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { SpotlightCard } from '@/components/ui/spotlight-card';
import { AgentAvatar } from '@/components/thread/content/agent-avatar';
import { TriggersScreen } from './screens/triggers-screen';
import { InstructionsScreen } from './screens/instructions-screen';
import { KnowledgeScreen } from './screens/knowledge-screen';
import { ToolsScreen } from './screens/tools-screen';
import { IntegrationsScreen } from './screens/integrations-screen';

type ConfigView = 'instructions' | 'knowledge' | 'triggers' | 'tools' | 'integrations';

export default function AgentConfigPage() {
  const params = useParams();
  const router = useRouter();
  const agentId = params.agentId as string;
  const [activeView, setActiveView] = useState<ConfigView>('triggers');

  const { data: agent, isLoading } = useAgent(agentId);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!agent) {
    return (
      <div className="flex items-center justify-center h-screen">
        <p className="text-muted-foreground">Agent not found</p>
      </div>
    );
  }

  const menuItems = [
    { id: 'instructions' as const, label: 'Instructions', icon: Brain },
    { id: 'tools' as const, label: 'Tools', icon: Wrench },
    { id: 'integrations' as const, label: 'Integrations', icon: Server },
    { id: 'knowledge' as const, label: 'Knowledge', icon: BookOpen },
    { id: 'triggers' as const, label: 'Triggers', icon: Zap },
  ];

  return (
    <div className="h-screen flex overflow-hidden bg-background px-7 pt-7">
      {/* Left Sidebar Menu */}
      <div className="w-48 bg-background flex flex-col pr-4">
        {/* Back button */}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => router.push('/agents?tab=my-agents')}
          className="justify-start -ml-2 mb-6 text-foreground hover:bg-transparent"
        >
          <ChevronLeft className="h-4 w-4 mr-1" />
          Back
        </Button>

        {/* Menu items */}
        <div className="space-y-1">
          {menuItems.map((item) => {
            const Icon = item.icon;
            const isActive = activeView === item.id;
            return (
              <SpotlightCard
                key={item.id}
                className={cn(
                  "transition-colors cursor-pointer",
                  isActive ? "bg-muted" : "bg-transparent"
                )}
                spotlightColor={isActive ? "rgba(255, 255, 255, 0.15)" : "rgba(255, 255, 255, 0.08)"}
              >
                <button
                  onClick={() => setActiveView(item.id)}
                  className={cn(
                    "w-full flex items-center gap-3 px-4 py-3 text-sm",
                    isActive
                      ? "text-foreground"
                      : "text-muted-foreground"
                  )}
                >
                  <Icon className="h-4 w-4" />
                  {item.label}
                </button>
              </SpotlightCard>
            );
          })}
        </div>
      </div>

      {/* Right Content Area */}
      <div className="flex-1 flex flex-col overflow-hidden pl-1 pr-1">
        {/* Agent Header - inline with content */}
        <div className="flex items-center justify-between pt-12 pb-6">
          <div className="flex items-center gap-3">
            <AgentAvatar
              agent={agent}
              size={48}
              className="!bg-card border-[1.5px]"
            />
            <div>
              <h1 className="text-xl font-semibold text-foreground">{agent.name}</h1>
              <p className="text-sm text-muted-foreground">
                {agent.system_prompt?.substring(0, 50) || 'Builds user interfaces and interactive web pages.'}
              </p>
            </div>
          </div>

        </div>

        {/* Dynamic Content Based on Active View */}
        {activeView === 'instructions' && <InstructionsScreen agentId={agentId} />}
        {activeView === 'tools' && <ToolsScreen agentId={agentId} />}
        {activeView === 'integrations' && <IntegrationsScreen agentId={agentId} />}
        {activeView === 'knowledge' && <KnowledgeScreen agentId={agentId} />}
        {activeView === 'triggers' && <TriggersScreen agentId={agentId} />}
      </div>
    </div>
  );
}
