'use client';

import React, { useMemo } from 'react';
import {
  CheckCircle,
  AlertCircle,
  BarChart3,
  Cpu,
  DollarSign,
  MessageSquare,
  Wrench,
  Clock,
} from 'lucide-react';
import { ToolViewProps } from '../types';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ToolViewIconTitle } from '../shared/ToolViewIconTitle';
import { ToolViewFooter } from '../shared/ToolViewFooter';
import { LoadingState } from '../shared/LoadingState';

// ── Parsing ──────────────────────────────────────────────────────────────────

interface SessionStats {
  name: string;
  id: string;
  provider: string;
  model: string;
  contextLimit: string;
  totalTokens: string;
  usage: string;
  inputTokens: string;
  outputTokens: string;
  reasoningTokens: string;
  cache: string;
  messages: string;
  toolCalls: string;
  totalCost: string;
  created: string;
  lastActivity: string;
}

function parseStatsOutput(output: string): SessionStats | null {
  if (!output || typeof output !== 'string') return null;

  const get = (label: string): string => {
    const re = new RegExp(`\\|\\s*\\*\\*${label}\\*\\*\\s*\\|\\s*(.+?)\\s*\\|`);
    const m = output.match(re);
    return m?.[1]?.trim().replace(/^`|`$/g, '') || '';
  };

  const name = get('Session');
  if (!name) return null;

  return {
    name,
    id: get('ID'),
    provider: get('Provider'),
    model: get('Model'),
    contextLimit: get('Context Limit'),
    totalTokens: get('Total Tokens'),
    usage: get('Usage'),
    inputTokens: get('Input Tokens'),
    outputTokens: get('Output Tokens'),
    reasoningTokens: get('Reasoning Tokens'),
    cache: get('Cache'),
    messages: get('Messages'),
    toolCalls: get('Tool Calls'),
    totalCost: get('Total Cost'),
    created: get('Created'),
    lastActivity: get('Last Activity'),
  };
}

// ── Component ────────────────────────────────────────────────────────────────

function StatRow({ icon: Icon, label, value }: { icon: typeof Clock; label: string; value: string }) {
  if (!value) return null;
  return (
    <div className="flex items-center gap-3 py-1.5 px-4">
      <Icon className="size-3.5 text-muted-foreground/50 flex-shrink-0" />
      <span className="text-xs text-muted-foreground min-w-[100px]">{label}</span>
      <span className="text-xs text-foreground font-mono truncate">{value}</span>
    </div>
  );
}

export function OcSessionStatsToolView({
  toolCall,
  toolResult,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
}: ToolViewProps) {
  const args = toolCall?.arguments || {};
  const ocState = (args as any)._oc_state as any;
  const rawOutput = toolResult?.output || ocState?.output || '';
  const output = typeof rawOutput === 'string' ? rawOutput : String(rawOutput);
  const isError = toolResult?.success === false || !!toolResult?.error;

  const stats = useMemo(() => parseStatsOutput(output), [output]);

  if (isStreaming && !toolResult) {
    return <LoadingState title="Session Stats" subtitle="Fetching statistics..." />;
  }

  return (
    <Card className="gap-0 flex border-0 shadow-none p-0 py-0 rounded-none flex-col h-full overflow-hidden bg-card">
      <CardHeader className="h-14 bg-muted/50 backdrop-blur-sm border-b p-2 px-4 space-y-2">
        <div className="flex flex-row items-center justify-between">
          <ToolViewIconTitle
            icon={BarChart3}
            title="Session Stats"
            subtitle={stats?.name || (args.session_id as string) || 'Loading...'}
          />
          {stats && (
            <Badge variant="outline" className="h-6 py-0.5 flex-shrink-0 ml-2">
              {stats.usage} used
            </Badge>
          )}
        </div>
      </CardHeader>

      <CardContent className="p-0 h-full flex-1 overflow-hidden">
        {stats ? (
          <ScrollArea className="h-full w-full">
            <div className="py-2 divide-y divide-border/30">
              {/* Identity */}
              <div className="pb-2">
                <div className="px-4 py-1 text-[10px] uppercase tracking-wider text-muted-foreground/50 font-medium">
                  Session
                </div>
                <StatRow icon={MessageSquare} label="Name" value={stats.name} />
                <StatRow icon={BarChart3} label="ID" value={stats.id} />
                <StatRow icon={Cpu} label="Provider" value={stats.provider} />
                <StatRow icon={Cpu} label="Model" value={stats.model} />
              </div>

              {/* Token usage */}
              <div className="py-2">
                <div className="px-4 py-1 text-[10px] uppercase tracking-wider text-muted-foreground/50 font-medium">
                  Tokens
                </div>
                <StatRow icon={BarChart3} label="Context Limit" value={stats.contextLimit} />
                <StatRow icon={BarChart3} label="Total" value={stats.totalTokens} />
                <StatRow icon={BarChart3} label="Usage" value={stats.usage} />
                <StatRow icon={BarChart3} label="Input" value={stats.inputTokens} />
                <StatRow icon={BarChart3} label="Output" value={stats.outputTokens} />
                <StatRow icon={BarChart3} label="Reasoning" value={stats.reasoningTokens} />
                <StatRow icon={BarChart3} label="Cache" value={stats.cache} />
              </div>

              {/* Activity */}
              <div className="py-2">
                <div className="px-4 py-1 text-[10px] uppercase tracking-wider text-muted-foreground/50 font-medium">
                  Activity
                </div>
                <StatRow icon={MessageSquare} label="Messages" value={stats.messages} />
                <StatRow icon={Wrench} label="Tool Calls" value={stats.toolCalls} />
                <StatRow icon={DollarSign} label="Total Cost" value={stats.totalCost} />
                <StatRow icon={Clock} label="Created" value={stats.created} />
                <StatRow icon={Clock} label="Last Activity" value={stats.lastActivity} />
              </div>
            </div>
          </ScrollArea>
        ) : output && !isError ? (
          <ScrollArea className="h-full w-full">
            <div className="p-3 text-sm text-muted-foreground whitespace-pre-wrap font-mono">
              {output.slice(0, 5000)}
            </div>
          </ScrollArea>
        ) : isError ? (
          <div className="flex items-start gap-2.5 px-4 py-6 text-muted-foreground">
            <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
            <p className="text-sm">{output || 'Failed to get session stats'}</p>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center h-full py-12 px-6">
            <BarChart3 className="h-8 w-8 text-muted-foreground/30 mb-3" />
            <p className="text-sm text-muted-foreground">Loading statistics...</p>
          </div>
        )}
      </CardContent>

      <ToolViewFooter
        assistantTimestamp={assistantTimestamp}
        toolTimestamp={toolTimestamp}
        isStreaming={isStreaming}
      >
        {!isStreaming && (
          isError ? (
            <Badge variant="outline" className="h-6 py-0.5 bg-muted text-muted-foreground">
              <AlertCircle className="h-3 w-3" />
              Failed
            </Badge>
          ) : stats ? (
            <Badge variant="outline" className="h-6 py-0.5 bg-muted">
              <CheckCircle className="h-3 w-3 text-muted-foreground" />
              Loaded
            </Badge>
          ) : null
        )}
      </ToolViewFooter>
    </Card>
  );
}
