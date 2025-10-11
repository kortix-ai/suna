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
    <div className="h-screen flex flex-col md:flex-row overflow-hidden bg-background md:px-7 md:pt-7">
      {/* Left Sidebar Menu */}
      <div className="bg-background flex w-full md:w-48 md:flex-col md:pr-4 px-4 pt-20 md:px-0 md:pt-0 gap-2">
        {/* Back button - desktop only */}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => router.push('/agents?tab=my-agents')}
          className="justify-start -ml-2 mb-6 text-foreground hover:bg-transparent hidden md:flex"
        >
          <ChevronLeft className="h-4 w-4 mr-1" />
          Back
        </Button>

        {/* Back button - mobile (icon only) */}
        <Button
          variant="ghost"
          size="icon"
          onClick={() => router.push('/agents?tab=my-agents')}
          className="h-12 w-12 p-0 cursor-pointer hover:bg-muted/60 hover:border-[1.5px] hover:border-border md:hidden"
        >
          <ChevronLeft className="!h-5 !w-5" />
        </Button>

        {/* Menu items - desktop */}
        <div className="space-y-1 hidden md:block">
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

        {/* Menu items - mobile (icon only) */}
        <div className="flex gap-2 md:hidden md:space-y-2">
          {menuItems.map((item) => {
            const Icon = item.icon;
            const isActive = activeView === item.id;
            return (
              <Button
                key={item.id}
                variant="ghost"
                size="icon"
                className={cn(
                  "h-12 w-12 p-0 cursor-pointer hover:bg-muted/60 hover:border-[1.5px] hover:border-border",
                  isActive ? 'bg-muted/60 border-[1.5px] border-border' : ''
                )}
                onClick={() => setActiveView(item.id)}
              >
                <Icon className="!h-5 !w-5" />
              </Button>
            );
          })}
        </div>
      </div>

      {/* Right Content Area */}
      <div className="flex-1 flex flex-col overflow-hidden w-full md:w-0 md:pl-1 md:pr-1 md:min-w-0 px-4 md:px-0">
        {/* Agent Header - inline with content */}
        <div className="flex items-center justify-between pt-12 pb-6 w-full">
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
