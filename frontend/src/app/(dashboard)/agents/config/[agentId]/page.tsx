'use client';

import React, { useState, useMemo } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useAgent } from '@/hooks/react-query/agents/use-agents';
import { useAgentTriggers, useToggleTrigger } from '@/hooks/react-query/triggers';
import { Bot, Settings, Loader2, Play, Pause, ChevronLeft, Brain, BookOpen, Zap, Workflow, Edit3 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { SpotlightCard } from '@/components/ui/spotlight-card';

type ConfigView = 'instructions' | 'knowledge' | 'triggers' | 'workflows';

export default function AgentConfigPage() {
  const params = useParams();
  const router = useRouter();
  const agentId = params.agentId as string;
  const [activeView, setActiveView] = useState<ConfigView>('triggers');
  const [searchQuery, setSearchQuery] = useState('');

  const { data: agent, isLoading: isAgentLoading } = useAgent(agentId);
  const { data: triggers = [], isLoading: isTriggersLoading } = useAgentTriggers(agentId);
  const toggleTriggerMutation = useToggleTrigger();

  const runningTriggers = useMemo(
    () => triggers.filter((trigger) => trigger.is_active),
    [triggers]
  );

  const pausedTriggers = useMemo(
    () => triggers.filter((trigger) => !trigger.is_active),
    [triggers]
  );

  const isLoading = isAgentLoading || isTriggersLoading;

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

  const handleToggleTrigger = async (triggerId: string, currentStatus: boolean) => {
    try {
      await toggleTriggerMutation.mutateAsync({
        triggerId,
        isActive: !currentStatus,
      });
      toast.success(currentStatus ? 'Trigger paused' : 'Trigger activated');
    } catch (error) {
      toast.error('Failed to toggle trigger');
    }
  };

  const handleEditTrigger = (triggerId: string) => {
    toast.info('Edit trigger functionality coming soon');
  };

  const menuItems = [
    { id: 'instructions' as const, label: 'Instructions', icon: Brain },
    { id: 'knowledge' as const, label: 'Knowledge', icon: BookOpen },
    { id: 'triggers' as const, label: 'Triggers', icon: Zap },
    { id: 'workflows' as const, label: 'Workflows', icon: Workflow },
  ];

  return (
    <div className="h-screen flex overflow-hidden bg-background">
      {/* Left Sidebar Menu */}
      <div className="w-48 bg-background flex flex-col p-4">
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
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Agent Header - inline with content */}
        <div className="flex items-center justify-between px-6 py-6 pb-4">
          <div className="flex items-center gap-3">
            <div
              className="flex items-center justify-center w-14 h-14 rounded-2xl"
              style={{
                backgroundColor: agent.icon_background || '#f3f4f6',
                color: agent.icon_color || '#6b7280'
              }}
            >
              <Bot className="h-6 w-6" />
            </div>
            <div>
              <h1 className="text-xl font-semibold text-foreground">{agent.name}</h1>
              <p className="text-sm text-muted-foreground">
                {agent.system_prompt?.substring(0, 50) || 'Builds user interfaces and interactive web pages.'}
              </p>
            </div>
          </div>

          <Button
            variant="ghost"
            size="icon"
            className="h-10 w-10 rounded-xl"
          >
            <Edit3 className="h-4 w-4" />
          </Button>
        </div>

        {/* Dynamic Content Based on Active View */}
        {activeView === 'triggers' && (
          <TriggersView
            runningTriggers={runningTriggers}
            pausedTriggers={pausedTriggers}
            searchQuery={searchQuery}
            setSearchQuery={setSearchQuery}
            onToggleTrigger={handleToggleTrigger}
            onEditTrigger={handleEditTrigger}
          />
        )}

        {activeView === 'instructions' && (
          <div className="flex-1 flex items-center justify-center text-muted-foreground">
            <div className="text-center">
              <Brain className="h-12 w-12 mx-auto mb-4" />
              <p>Instructions view coming soon</p>
            </div>
          </div>
        )}

        {activeView === 'knowledge' && (
          <div className="flex-1 flex items-center justify-center text-muted-foreground">
            <div className="text-center">
              <BookOpen className="h-12 w-12 mx-auto mb-4" />
              <p>Knowledge view coming soon</p>
            </div>
          </div>
        )}

        {activeView === 'workflows' && (
          <div className="flex-1 flex items-center justify-center text-muted-foreground">
            <div className="text-center">
              <Workflow className="h-12 w-12 mx-auto mb-4" />
              <p>Workflows view coming soon</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

interface TriggersViewProps {
  runningTriggers: any[];
  pausedTriggers: any[];
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  onToggleTrigger: (triggerId: string, currentStatus: boolean) => void;
  onEditTrigger: (triggerId: string) => void;
}

function TriggersView({
  runningTriggers,
  pausedTriggers,
  searchQuery,
  setSearchQuery,
  onToggleTrigger,
  onEditTrigger,
}: TriggersViewProps) {
  return (
    <div className="flex-1 overflow-auto">
      {/* Search Bar */}
      <div className="px-6 pb-4">
        <div className="relative">
          <Input
            type="text"
            placeholder="Search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-10 bg-background"
          />
          <div className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">
            <Settings className="h-4 w-4" />
          </div>
          <div className="absolute right-3 top-1/2 -translate-y-1/2">
            <Button variant="ghost" size="sm" className="text-xs h-7 px-2">
              Most Used
            </Button>
          </div>
        </div>
      </div>

      {/* Triggers Content */}
      <div className="px-6 pb-6">
        {runningTriggers.length === 0 && pausedTriggers.length === 0 ? (
          <div className="text-center py-12">
            <Zap className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
            <h3 className="text-lg font-semibold mb-2">No triggers configured</h3>
            <p className="text-sm text-muted-foreground mb-4">
              Set up triggers to automate this agent
            </p>
          </div>
        ) : (
          <>
            {/* Running Section */}
            {runningTriggers.length > 0 && (
              <section className="mb-6">
                <h2 className="text-sm font-medium mb-3">Running</h2>
                <div className="space-y-2">
                  {runningTriggers.map((trigger) => (
                    <TriggerRunCard
                      key={trigger.trigger_id}
                      triggerId={trigger.trigger_id}
                      title={trigger.name}
                      description={trigger.description || 'Builds user interfaces and interactive web pages.'}
                      status="running"
                      onToggle={() => onToggleTrigger(trigger.trigger_id, trigger.is_active)}
                      onEdit={() => onEditTrigger(trigger.trigger_id)}
                    />
                  ))}
                </div>
              </section>
            )}

            {/* Paused Section */}
            {pausedTriggers.length > 0 && (
              <section>
                <h2 className="text-sm font-medium mb-3">Paused</h2>
                <div className="space-y-2">
                  {pausedTriggers.map((trigger) => (
                    <TriggerRunCard
                      key={trigger.trigger_id}
                      triggerId={trigger.trigger_id}
                      title={trigger.name}
                      description={trigger.description || 'Builds user interfaces and interactive web pages.'}
                      status="paused"
                      onToggle={() => onToggleTrigger(trigger.trigger_id, trigger.is_active)}
                      onEdit={() => onEditTrigger(trigger.trigger_id)}
                    />
                  ))}
                </div>
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}

interface TriggerRunCardProps {
  triggerId: string;
  title: string;
  description: string;
  status: 'running' | 'paused';
  onToggle: () => void;
  onEdit: () => void;
}

function TriggerRunCard({ triggerId, title, description, status, onToggle, onEdit }: TriggerRunCardProps) {
  return (
    <div className="flex items-center justify-between p-5 rounded-2xl bg-card/40 hover:bg-card/60 transition-colors">
      <div className="flex items-center gap-4 flex-1 min-w-0">
        <div className="flex items-center justify-center w-12 h-12 rounded-xl bg-background border border-border/50 flex-shrink-0">
          <Edit3 className="h-5 w-5 text-foreground" />
        </div>

        <div className="flex-1 min-w-0">
          <h3 className="font-medium text-foreground mb-0.5">{title}</h3>
          <p className="text-sm text-muted-foreground">{description}</p>
        </div>
      </div>

      <div className="flex items-center gap-2 ml-4">
        <Button
          variant="ghost"
          size="icon"
          onClick={onToggle}
          className="h-10 w-10 rounded-full bg-background border border-border/50 hover:bg-muted"
        >
          {status === 'running' ? (
            <Pause className="h-4 w-4 fill-current" />
          ) : (
            <Play className="h-4 w-4 fill-current ml-0.5" />
          )}
        </Button>

        <Button
          variant="ghost"
          size="icon"
          onClick={onEdit}
          className="h-10 w-10 rounded-full bg-background border border-border/50 hover:bg-muted"
        >
          <Settings className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
