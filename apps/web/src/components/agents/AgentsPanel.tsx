'use client';

import React, { useState, useCallback, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import {
  GitBranch,
  Plus,
  ExternalLink,
  Activity,
  Clock,
  Minus,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { backendApi } from '@/lib/api-client';

// ─── Types ────────────────────────────────────────────────────────────────────

type AgentStatus = 'running' | 'idle' | 'blocked';

interface AgentSession {
  session_id: string;
  task_title: string;
  status: AgentStatus;
  branch_name: string | null;
  last_activity_at: string;
  diff_additions: number | null;
  diff_deletions: number | null;
  pr_url: string | null;
}

interface SessionsResponse {
  sessions: AgentSession[];
  next_cursor: string | null;
}

// ─── API helpers ──────────────────────────────────────────────────────────────

async function fetchSessions(cursor?: string): Promise<SessionsResponse> {
  const params = new URLSearchParams({ limit: '20' });
  if (cursor) params.set('cursor', cursor);
  const res = await backendApi.get<SessionsResponse>(`/agents/sessions?${params}`);
  return res.data ?? { sessions: [], next_cursor: null };
}

async function createSession(task: string, worktree?: string): Promise<{ session_id: string; branch_name: string | null; status: string }> {
  const res = await backendApi.post<{ session_id: string; branch_name: string | null; status: string }>(
    '/agents/sessions',
    { task, ...(worktree ? { worktree } : {}) },
  );
  if (!res.data) throw new Error('Failed to create session');
  return res.data;
}

// ─── Status badge ─────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: AgentStatus }) {
  const config = {
    running: { label: 'Running', className: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400 border-green-200 dark:border-green-800' },
    idle: { label: 'Idle', className: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400 border-zinc-200 dark:border-zinc-700' },
    blocked: { label: 'Blocked', className: 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-400 border-orange-200 dark:border-orange-800' },
  }[status];

  return (
    <span className={cn('inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium border', config.className)}>
      <span className={cn('h-1.5 w-1.5 rounded-full', status === 'running' ? 'bg-green-500 animate-pulse' : status === 'blocked' ? 'bg-orange-500' : 'bg-zinc-400')} />
      {config.label}
    </span>
  );
}

// ─── Session row ──────────────────────────────────────────────────────────────

function SessionRow({ session }: { session: AgentSession }) {
  const branch = session.branch_name && session.branch_name.length > 32
    ? session.branch_name.slice(0, 32) + '…'
    : session.branch_name;

  const relativeTime = formatDistanceToNow(new Date(session.last_activity_at), { addSuffix: true });

  return (
    <div className="flex items-start gap-3 p-3 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 hover:bg-zinc-50 dark:hover:bg-zinc-900/50 transition-colors">
      {/* Status + task */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <StatusBadge status={session.status} />
          {session.pr_url && (
            <a
              href={session.pr_url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400 border border-blue-200 dark:border-blue-800 hover:opacity-80 transition-opacity"
            >
              PR
              <ExternalLink className="h-2.5 w-2.5" />
            </a>
          )}
        </div>
        <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100 truncate" title={session.task_title}>
          {session.task_title || 'Untitled task'}
        </p>
        <div className="flex items-center gap-3 mt-1">
          {branch && (
            <span className="flex items-center gap-1 text-xs text-zinc-500 dark:text-zinc-400 font-mono">
              <GitBranch className="h-3 w-3" />
              {branch}
            </span>
          )}
          {(session.diff_additions !== null || session.diff_deletions !== null) && (
            <span className="flex items-center gap-1 text-xs font-mono">
              {session.diff_additions !== null && (
                <span className="text-green-700 dark:text-green-400 flex items-center gap-0.5">
                  <Plus className="h-2.5 w-2.5" />{session.diff_additions}
                </span>
              )}
              {session.diff_deletions !== null && (
                <span className="text-red-700 dark:text-red-400 flex items-center gap-0.5">
                  <Minus className="h-2.5 w-2.5" />{session.diff_deletions}
                </span>
              )}
            </span>
          )}
          <span className="flex items-center gap-1 text-xs text-zinc-400 dark:text-zinc-500">
            <Clock className="h-3 w-3" />
            {relativeTime}
          </span>
        </div>
      </div>
    </div>
  );
}

// ─── New Agent Modal ──────────────────────────────────────────────────────────

function NewAgentModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [task, setTask] = useState('');
  const [branch, setBranch] = useState('');
  const queryClient = useQueryClient();

  const { mutate, isPending, error } = useMutation({
    mutationFn: () => createSession(task.trim(), branch.trim() || undefined),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agents-sessions'] });
      setTask('');
      setBranch('');
      onClose();
    },
  });

  const handleSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    if (!task.trim()) return;
    mutate();
  }, [task, mutate]);

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New agent</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="task">Task</Label>
            <Textarea
              id="task"
              placeholder="Describe what the agent should do…"
              value={task}
              onChange={(e) => setTask(e.target.value)}
              rows={3}
              required
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="branch">Branch <span className="text-zinc-400 font-normal">(optional)</span></Label>
            <Input
              id="branch"
              placeholder="feature/my-task"
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              className="font-mono text-sm"
            />
            <p className="text-xs text-zinc-500">Creates a git worktree for this branch.</p>
          </div>
          {error && (
            <p className="text-xs text-red-600 dark:text-red-400">{(error as Error).message}</p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={!task.trim() || isPending}>
              {isPending ? 'Starting…' : 'Start agent'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ─── Main Panel ───────────────────────────────────────────────────────────────

export function AgentsPanel() {
  const [modalOpen, setModalOpen] = useState(false);
  const queryClient = useQueryClient();

  const { data, isLoading, error } = useQuery({
    queryKey: ['agents-sessions'],
    queryFn: () => fetchSessions(),
    refetchInterval: 5000,  // poll every 5s for live status updates
    staleTime: 2000,
  });

  const sessions = data?.sessions ?? [];
  const runningSessions = sessions.filter((s) => s.status === 'running');

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-200 dark:border-zinc-800">
        <div className="flex items-center gap-3">
          <Activity className="h-5 w-5 text-zinc-600 dark:text-zinc-400" />
          <h1 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Agents</h1>
          {runningSessions.length > 0 && (
            <Badge variant="secondary" className="text-xs">
              {runningSessions.length} running
            </Badge>
          )}
        </div>
        <Button size="sm" onClick={() => setModalOpen(true)} className="gap-1.5">
          <Plus className="h-4 w-4" />
          New agent
        </Button>
      </div>

      {/* Session list */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {isLoading ? (
          <div className="space-y-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="h-16 rounded-lg border border-zinc-200 dark:border-zinc-800 animate-pulse bg-zinc-100 dark:bg-zinc-900" />
            ))}
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center h-40 text-sm text-zinc-500">
            <p>Failed to load sessions. Retrying…</p>
          </div>
        ) : sessions.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-40 text-sm text-zinc-500 gap-3">
            <Activity className="h-8 w-8 text-zinc-300 dark:text-zinc-700" />
            <p>No active agent sessions.</p>
            <Button size="sm" variant="outline" onClick={() => setModalOpen(true)}>
              Start your first agent
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            {sessions.map((session) => (
              <SessionRow key={session.session_id} session={session} />
            ))}
          </div>
        )}
      </div>

      <NewAgentModal open={modalOpen} onClose={() => setModalOpen(false)} />
    </div>
  );
}
