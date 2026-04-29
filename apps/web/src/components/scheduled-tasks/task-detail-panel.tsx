"use client";

import React, { useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { FilterBar, FilterBarItem } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  X,
  Trash2,
  Power,
  PowerOff,
  Save,
  Play,
  Timer,
  Clock,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  SkipForward,
  Loader2,
  ExternalLink,
  Webhook,
} from 'lucide-react';
import { ScheduleBuilder } from './schedule-builder';
import {
  useUpdateTrigger,
  useDeleteTrigger,
  useToggleTrigger,
  useRunTrigger,
  useTriggerExecutions,
  type Trigger,
  type Execution,
  type SessionMode,
  type ExecutionStatus,
} from '@/hooks/scheduled-tasks';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { useSandbox } from '@/hooks/platform/use-sandbox';
import { getSandboxUrl } from '@/lib/platform-client';
import { AgentSelector } from '@/components/session/session-chat-input';
import { useVisibleAgents } from '@/hooks/opencode/use-opencode-sessions';

// ─── Helpers ────────────────────────────────────────────────────────────────

const TIMEZONES = [
  'UTC',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'Europe/London',
  'Europe/Berlin',
  'Europe/Paris',
  'Asia/Tokyo',
  'Asia/Shanghai',
  'Asia/Kolkata',
  'Australia/Sydney',
];

function describeCron(expr: string): string {
  try {
    const parts = expr.trim().split(/\s+/);
    if (parts.length !== 6) return expr;
    const [sec, min, hour, day, month, weekday] = parts;
    if (sec.startsWith('*/') && min === '*' && hour === '*') return `Every ${sec.slice(2)}s`;
    if (sec === '0' && min.startsWith('*/') && hour === '*') return `Every ${min.slice(2)}m`;
    if (sec === '0' && min === '0' && hour.startsWith('*/')) return `Every ${hour.slice(2)}h`;
    if (sec === '0' && !min.includes('*') && !hour.includes('*') && day === '*' && month === '*' && weekday === '*') {
      return `Daily at ${hour.padStart(2, '0')}:${min.padStart(2, '0')}`;
    }
    return expr;
  } catch { return expr; }
}

function formatDuration(ms: number | null): string {
  if (ms === null) return '--';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function formatDateTime(dateStr: string | null): string {
  if (!dateStr) return 'Never';
  return new Date(dateStr).toLocaleString();
}

function getStatusIcon(status: ExecutionStatus) {
  switch (status) {
    case 'completed': return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />;
    case 'failed': return <XCircle className="h-3.5 w-3.5 text-red-500" />;
    case 'timeout': return <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />;
    case 'skipped': return <SkipForward className="h-3.5 w-3.5 text-muted-foreground" />;
    case 'running': return <Loader2 className="h-3.5 w-3.5 text-blue-500 animate-spin" />;
    case 'pending': return <Clock className="h-3.5 w-3.5 text-muted-foreground" />;
    default: return <Clock className="h-3.5 w-3.5 text-muted-foreground" />;
  }
}

function getStatusColor(status: ExecutionStatus): string {
  switch (status) {
    case 'completed': return 'text-emerald-600 dark:text-emerald-400';
    case 'failed': return 'text-red-600 dark:text-red-400';
    case 'timeout': return 'text-amber-600 dark:text-amber-400';
    case 'skipped': return 'text-muted-foreground';
    case 'running': return 'text-blue-600 dark:text-blue-400';
    default: return 'text-muted-foreground';
  }
}

// ─── Component ──────────────────────────────────────────────────────────────

interface TaskDetailPanelProps {
  trigger: Trigger;
  onClose: () => void;
}

export function TaskDetailPanel({ trigger, onClose }: TaskDetailPanelProps) {
  const router = useRouter();
  const { sandbox } = useSandbox();
  const webhookBaseUrl = useMemo(() => {
    try { if (sandbox) return getSandboxUrl(sandbox); } catch {}
    return 'https://<sandbox-url>';
  }, [sandbox]);
  const [tab, setTab] = useState<'settings' | 'executions'>('settings');
  const [name, setName] = useState(trigger.name);
  const [cronExpr, setCronExpr] = useState(trigger.cronExpr || '');
  const [timezone, setTimezone] = useState(trigger.timezone || 'UTC');
  const [prompt, setPrompt] = useState(trigger.prompt);
  const [sessionMode, setSessionMode] = useState<SessionMode>(trigger.sessionMode as SessionMode);
  const [agentName, setAgentName] = useState<string | null>(trigger.agentName || null);
  const [webhookPath, setWebhookPath] = useState(trigger.webhook?.path || '');
  // Webhook method is always POST (standard webhook convention)
  const [isDirty, setIsDirty] = useState(false);

  const updateMutation = useUpdateTrigger();
  const deleteMutation = useDeleteTrigger();
  const toggleMutation = useToggleTrigger();
  const runMutation = useRunTrigger();

  // Use shared hooks (same as ChatInput / channels)
  const agents = useVisibleAgents();

  const { data: executions = [] } = useTriggerExecutions(
    tab === 'executions' && trigger.triggerId ? trigger.triggerId : '',
  );

  // Sync state when trigger prop changes
  React.useEffect(() => {
    setName(trigger.name);
    setCronExpr(trigger.cronExpr || '');
    setTimezone(trigger.timezone || 'UTC');
    setPrompt(trigger.prompt);
    setSessionMode(trigger.sessionMode as SessionMode);
    setAgentName(trigger.agentName || null);
    setWebhookPath(trigger.webhook?.path || '');
    setIsDirty(false);
  }, [trigger.id, trigger.name, trigger.cronExpr, trigger.timezone, trigger.prompt, trigger.sessionMode, trigger.agentName, trigger.webhook?.path]);

  const markDirty = () => setIsDirty(true);

  const handleSave = async () => {
    if (!trigger.triggerId) return;
    try {
      const data: any = { name, session_mode: sessionMode, agent_name: agentName || null };
      if (trigger.type === 'cron') {
        data.cron_expr = cronExpr;
        data.timezone = timezone;
      }
      if (trigger.type === 'webhook') {
        data.source = { path: webhookPath };
      }
      if (trigger.action_type === 'prompt' || !trigger.action_type) {
        data.prompt = prompt;
      }
      await updateMutation.mutateAsync({ id: trigger.triggerId, data });
      toast.success('Trigger updated');
      setIsDirty(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update');
    }
  };

  const handleToggle = async () => {
    if (!trigger.triggerId) return;
    try {
      await toggleMutation.mutateAsync({ id: trigger.triggerId, isActive: !trigger.isActive });
      toast.success(trigger.isActive ? 'Task paused' : 'Task resumed');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to toggle');
    }
  };

  const handleRun = async () => {
    if (!trigger.triggerId) return;
    try {
      await runMutation.mutateAsync(trigger.triggerId);
      toast.success('Task triggered manually');
      // Switch to executions tab to show result
      setTab('executions');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to run');
    }
  };

  const handleDelete = async () => {
    if (!trigger.triggerId) return;
    if (!confirm('Are you sure you want to delete this task? This cannot be undone.')) {
      return;
    }
    try {
      await deleteMutation.mutateAsync(trigger.triggerId);
      toast.success('Task deleted');
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete');
    }
  };

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-10 h-10 rounded-lg bg-muted">
            {trigger.type === 'cron' ? <Timer className="h-5 w-5" /> : <Webhook className="h-5 w-5" />}
          </div>
          <div>
            <h2 className="font-semibold text-foreground">{trigger.name}</h2>
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">
                {trigger.type === 'cron' ? describeCron(trigger.cronExpr || '') : `${trigger.webhook?.method || 'POST'} ${trigger.webhook?.path || ''}`}
              </span>
              <Badge variant={trigger.isActive ? 'highlight' : 'secondary'} className="text-xs">
                {trigger.type === 'cron' ? (trigger.isActive ? 'Active' : 'Paused') : 'Webhook'}
              </Badge>
            </div>
          </div>
        </div>
        <Button variant="ghost" size="icon" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </div>

      {/* Tabs */}
      <FilterBar className="w-full px-2">
        <FilterBarItem
          onClick={() => setTab('settings')}
          data-state={tab === 'settings' ? 'active' : 'inactive'}
          className="flex-1"
        >
          Settings
        </FilterBarItem>
        <FilterBarItem
          onClick={() => setTab('executions')}
          data-state={tab === 'executions' ? 'active' : 'inactive'}
          className="flex-1"
        >
          Executions
        </FilterBarItem>
      </FilterBar>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4 pb-12">
        {tab === 'settings' ? (
          <div className="space-y-5">
            {/* Name */}
            <div className="space-y-2">
              <Label htmlFor="edit-name">Name</Label>
              <Input type="text"
                id="edit-name"
                value={name}
                onChange={(e) => { setName(e.target.value); markDirty(); }}
                className="rounded-xl"
              />
            </div>

            {trigger.type === 'cron' ? (
              <>
                <div className="space-y-2">
                  <Label>Schedule</Label>
                  <ScheduleBuilder
                    value={cronExpr}
                    onChange={(v) => { setCronExpr(v); markDirty(); }}
                    compact
                  />
                </div>

                <div className="space-y-2">
                  <Label>Timezone</Label>
                   <Select value={timezone} onValueChange={(v) => { setTimezone(v); markDirty(); }}>
                    <SelectTrigger className="cursor-pointer rounded-xl hover:bg-muted/40 transition-colors">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {TIMEZONES.map((tz) => (
                        <SelectItem key={tz} value={tz} className="cursor-pointer">{tz}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </>
            ) : (
              <div className="space-y-3">
                <div className="space-y-2">
                  <Label>Webhook Path</Label>
                  <Input type="text" value={webhookPath} onChange={(e) => { setWebhookPath(e.target.value); markDirty(); }} placeholder="/hooks/my-endpoint" className="rounded-xl" />
                </div>

                {/* Full external URL + curl example */}
                <div className="rounded-xl bg-muted/50 border p-3 space-y-2">
                  <div className="text-xs font-medium text-muted-foreground">External URL</div>
                  <code className="text-xs font-mono text-foreground break-all block select-all">
                    {webhookBaseUrl}{trigger.webhook?.path || webhookPath || '/hooks/...'}
                  </code>
                  <div className="text-xs font-medium text-muted-foreground pt-1">Example curl</div>
                  <code className="text-[11px] font-mono text-foreground/70 break-all block select-all whitespace-pre-wrap">
{`curl -X POST "${webhookBaseUrl}${trigger.webhook?.path || webhookPath}"${trigger.webhook?.secretProtected ? ` \\\n  -H "X-Kortix-Trigger-Secret: <secret>"` : ''} \\
  -H "Content-Type: application/json" \\
  -d '{"key": "value"}'`}
                  </code>
                </div>

                <div className="space-y-2">
                  <Label>Secret</Label>
                  <div className="h-9 px-3 flex items-center rounded-xl border border-input bg-muted/50 text-sm text-muted-foreground">
                    {trigger.webhook?.secretProtected ? 'Protected' : 'None'}
                  </div>
                </div>
              </div>
            )}

            {/* Prompt (for prompt actions) */}
            {(trigger.action_type === 'prompt' || !trigger.action_type) && (
            <div className="space-y-2">
              <Label htmlFor="edit-prompt">Prompt</Label>
              <Textarea
                id="edit-prompt"
                value={prompt}
                onChange={(e) => { setPrompt(e.target.value); markDirty(); }}
                placeholder="The instruction sent to your agent..."
                rows={4}
                className="rounded-xl"
              />
            </div>
            )}

            {/* Session Mode */}
            {(trigger.action_type === 'prompt' || !trigger.action_type) && (
            <div className="space-y-2">
              <Label>Session Mode</Label>
              <Select
                value={sessionMode}
                onValueChange={(v) => { setSessionMode(v as SessionMode); markDirty(); }}
              >
                <SelectTrigger className="cursor-pointer rounded-xl hover:bg-muted/40 transition-colors">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="new" className="cursor-pointer">New Session</SelectItem>
                  <SelectItem value="reuse" className="cursor-pointer">Reuse Session</SelectItem>
                </SelectContent>
              </Select>
            </div>
            )}

            {/* Agent Name (for prompt actions) */}
            {(trigger.action_type === 'prompt' || !trigger.action_type) && (
            <div className="space-y-2">
              <Label>Agent</Label>
              <div className="rounded-xl border bg-card px-2 py-1">
                <AgentSelector
                  agents={agents}
                  selectedAgent={agentName}
                  onSelect={(next) => { setAgentName(next); markDirty(); }}
                />
              </div>
            </div>
            )}

            {/* Info */}
            <div className="rounded-lg bg-muted/50 p-3 space-y-1.5 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Type</span>
                <span className="font-medium capitalize">{trigger.type} → {trigger.action_type ?? 'prompt'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Next run</span>
                 <span className="font-medium">
                   {trigger.type === 'cron' ? (trigger.isActive ? formatDateTime(trigger.nextRunAt) : 'Paused') : 'On demand'}
                 </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Last run</span>
                <span className="font-medium">{formatDateTime(trigger.lastRunAt)}</span>
              </div>
              {(trigger.action_type === 'prompt' || !trigger.action_type) && (
              <>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Model</span>
                <span className="font-medium">{trigger.modelId || 'Default (Sonnet)'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Agent</span>
                <span className="font-medium">{trigger.agentName || 'Default'}</span>
              </div>
              </>
              )}
              <div className="flex justify-between">
                <span className="text-muted-foreground">Created</span>
                <span className="font-medium">{new Date(trigger.createdAt).toLocaleDateString()}</span>
              </div>
            </div>

            {/* Actions */}
            <div className="space-y-2 pt-2">
               {isDirty && (
                 <Button
                  onClick={handleSave}
                  disabled={updateMutation.isPending}
                  className="w-full cursor-pointer "
                >
                  <Save className="h-4 w-4 mr-2" />
                  {updateMutation.isPending ? 'Saving...' : 'Save Changes'}
                </Button>
              )}
              {trigger.triggerId && (
              <Button
                variant="outline"
                onClick={handleRun}
                disabled={runMutation.isPending}
                className="w-full cursor-pointer "
              >
                <Play className="h-4 w-4 mr-2" />
                {runMutation.isPending ? 'Running...' : 'Run Now'}
              </Button>
              )}
              {trigger.triggerId && (
              <Button
                variant="outline"
                onClick={handleToggle}
                disabled={toggleMutation.isPending}
                className="w-full cursor-pointer "
              >
                {trigger.isActive ? (
                  <>
                    <PowerOff className="h-4 w-4 mr-2" />
                    Pause Trigger
                  </>
                ) : (
                  <>
                    <Power className="h-4 w-4 mr-2" />
                    Resume Trigger
                  </>
                )}
              </Button>
              )}
              {trigger.triggerId && (
              <Button
                variant="destructive"
                onClick={handleDelete}
                disabled={deleteMutation.isPending}
                className="w-full cursor-pointer "
              >
                <Trash2 className="h-4 w-4 mr-2" />
                {deleteMutation.isPending ? 'Deleting...' : 'Delete Trigger'}
              </Button>
              )}
            </div>
          </div>
        ) : (
          /* Executions Tab */
          <div className="space-y-3">
            {executions.length === 0 ? (
              <div className="text-center py-8">
                <Clock className="h-8 w-8 text-muted-foreground mx-auto mb-2" />
                <p className="text-sm text-muted-foreground">No executions yet</p>
                <p className="text-xs text-muted-foreground mt-1">
                  Executions will appear here once the trigger runs
                </p>
              </div>
            ) : (
                executions.map((exec) => (
                  <ExecutionItem key={exec.executionId} execution={exec} onOpenSession={(sessionId) => router.push(`/sessions/${sessionId}`)} />
                ))
              )}
            </div>
        )}
      </div>
    </div>
  );
}

// ─── Execution Item ─────────────────────────────────────────────────────────

function ExecutionItem({
  execution,
  onOpenSession,
}: {
  execution: Execution;
  onOpenSession: (sessionId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const canOpenSession = !!execution.sessionId;

  return (
    <div
      className={cn(
        'rounded-lg border p-3 text-sm transition-colors',
        canOpenSession ? 'cursor-pointer hover:bg-muted/30' : 'cursor-default'
      )}
      onClick={() => {
        if (execution.sessionId) {
          onOpenSession(execution.sessionId);
          return;
        }
        setExpanded(!expanded);
      }}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {getStatusIcon(execution.status)}
          <span className={cn("font-medium capitalize", getStatusColor(execution.status))}>
            {execution.status}
          </span>
          {execution.retryCount > 0 && (
            <span className="text-xs text-muted-foreground">(retry {execution.retryCount})</span>
          )}
        </div>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          {execution.sessionId && <ExternalLink className="h-3.5 w-3.5" />}
          <span>{formatDuration(execution.durationMs)}</span>
          <span>{execution.startedAt ? new Date(execution.startedAt).toLocaleString() : '--'}</span>
        </div>
      </div>
      {execution.sessionId && (
        <div className="mt-2 text-xs text-muted-foreground">
          Open session `{execution.sessionId}`
        </div>
      )}
      {execution.exitCode !== undefined && execution.exitCode !== null && (
        <div className="mt-1 text-xs text-muted-foreground">
          Exit code: <span className={execution.exitCode === 0 ? 'text-emerald-500' : 'text-amber-500'}>{execution.exitCode}</span>
        </div>
      )}
      {execution.httpStatus !== undefined && execution.httpStatus !== null && (
        <div className="mt-1 text-xs text-muted-foreground">
          HTTP {execution.httpStatus}
        </div>
      )}
      {expanded && execution.errorMessage && (
        <div className="mt-2 p-2 rounded bg-red-50 dark:bg-red-950/30 text-xs text-red-700 dark:text-red-300 whitespace-pre-wrap">
          {execution.errorMessage}
        </div>
      )}
      {execution.result_text && (
        <ResultTextPreview text={execution.result_text} />
      )}
    </div>
  );
}

// ─── Result Text Preview ─────────────────────────────────────────────────────

function ResultTextPreview({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const PREVIEW_LEN = 300;
  const isLong = text.length > PREVIEW_LEN;
  const displayed = expanded ? text : text.slice(0, PREVIEW_LEN);

  return (
    <div className="mt-2 border-t border-zinc-100 dark:border-zinc-800 pt-2">
      <div className="text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-1">Last result</div>
      <div className="prose prose-xs dark:prose-invert max-w-none text-xs">
        <ReactMarkdown>{displayed}</ReactMarkdown>
      </div>
      {isLong && (
        <button
          onClick={(e) => { e.stopPropagation(); setExpanded((v) => !v); }}
          className="mt-1 text-xs text-blue-500 hover:text-blue-600 dark:text-blue-400"
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  );
}
