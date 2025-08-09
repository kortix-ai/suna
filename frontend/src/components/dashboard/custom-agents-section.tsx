'use client';

import React from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Ripple } from '../ui/ripple';

interface CustomAgent {
  id: string;
  name: string;
  description: string;
  emoji: string;
  color: string;
  comingSoon?: boolean;
}

const CUSTOM_AGENTS: CustomAgent[] = [
  {
    id: 'sheets-agent',
    name: 'Sheets Agent',
    description: 'Create, analyze, and manage spreadsheets with AI assistance',
    emoji: '📊',
    color: '#10b981',
    comingSoon: false
  },
  {
    id: 'slides-agent',
    name: 'Slides Agent',
    description: 'Build beautiful presentations and slide decks',
    emoji: '📽️',
    color: '#3b82f6',
    comingSoon: false
  },
  {
    id: 'data-analyst',
    name: 'Data Analyst',
    description: 'Analyze data, create visualizations, and generate insights',
    emoji: '📈',
    color: '#8b5cf6',
    comingSoon: true
  },
  {
    id: 'web-dev-agent',
    name: 'Web Dev Agent',
    description: 'Build websites, debug code, and deploy applications',
    emoji: '💻',
    color: '#f59e0b',
    comingSoon: true
  }
];

interface CustomAgentsSectionProps {
  onAgentSelect?: (agentId: string) => void;
}

export function CustomAgentsSection({ onAgentSelect }: CustomAgentsSectionProps) {
  const handleAgentClick = (agent: CustomAgent) => {
    if (agent.comingSoon) return;
    onAgentSelect?.(agent.id);
  };

  return (
    <div className="w-full max-w-6xl mx-auto px-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
        <div className="relative col-span-1 sm:col-span-2 lg:col-span-2 overflow-hidden rounded-3xl flex items-center justify-center border bg-background">
            <div className="relative px-8 py-16 text-start">
                <div className="mx-auto max-w-3xl space-y-6">
                    <h2 className="text-4xl font-semibold text-foreground mb-2">
                        Custom Agents
                    </h2>
                    <p className="text-muted-foreground text-sm">
                        Specialized AI agents built by the Kortix team for specific tasks
                    </p>
                </div>
            </div>
            <Ripple/>
        </div>
        {CUSTOM_AGENTS.map((agent) => (
          <div
            key={agent.id}
            className={cn(
              'group relative bg-muted/30 rounded-3xl overflow-hidden transition-all duration-300 border cursor-pointer flex flex-col min-h-[280px] border-border/50',
              agent.comingSoon 
                ? 'opacity-70 cursor-not-allowed' 
                : 'hover:border-primary/20'
            )}
            onClick={() => handleAgentClick(agent)}
          >
            <div className="absolute inset-0 bg-gradient-to-br from-primary/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
            
            <div className="relative p-6 flex flex-col flex-1">
              <div className="flex items-start justify-between mb-4">
                <div 
                  className="relative h-14 w-14 flex items-center justify-center rounded-2xl" 
                  style={{ backgroundColor: agent.color }}
                >
                  <div className="text-2xl">{agent.emoji}</div>
                  <div
                    className="absolute inset-0 rounded-2xl pointer-events-none opacity-0 dark:opacity-100 transition-opacity"
                    style={{
                      boxShadow: `0 16px 48px -8px ${agent.color}70, 0 8px 24px -4px ${agent.color}50`
                    }}
                  />
                </div>
              </div>
              <h3 className="text-lg font-semibold text-foreground mb-2 line-clamp-1">
                {agent.name}
              </h3>
              
              <p className="text-sm text-muted-foreground mb-4 line-clamp-2 min-h-[2.5rem] leading-relaxed">
                {agent.description}
              </p>
              <div className="flex-1 flex flex-col justify-end">
                {!agent.comingSoon && (
                  <Button 
                    variant="outline" 
                    size="sm"
                    className="w-full"
                  >
                    Select Agent
                  </Button>
                )}
                {agent.comingSoon && (
                <Button 
                  variant="outline" 
                  className="w-full"
                  disabled
                >
                  Coming Soon
                </Button>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
} 