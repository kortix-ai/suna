'use client';

import React, { useState, useCallback } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, Play, CheckCircle2, XCircle, Loader2, Layers, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { backendApi } from '@/lib/api-client';

// ─── Types ────────────────────────────────────────────────────────────────────

interface ParallelSession {
  session_id: string;
  task: string;
  index: number;
}

interface ParallelResult {
  sessions: ParallelSession[];
  failed: Array<{ index: number; error: string }>;
  total: number;
  spawned: number;
}

type SessionStatus = 'running' | 'idle' | 'error' | 'unknown';

interface LiveSession {
  session_id: string;
  task: string;
  task_title: string;
  status: SessionStatus;
  last_activity_at: string;
}

// ─── API helpers ──────────────────────────────────────────────────────────────

async function spawnParallel(payload: {
  tasks: string[];
  context?: string;
}): Promise<ParallelResult> {
  const res = await backendApi.post<ParallelResult>('/agents/parallel', payload);
  if (!res.data) throw new Error('Spawn failed');
  return res.data;
}

async function fetchSessionStatuses(sessionIds: string[]): Promise<Record<string, SessionStatus>> {
  if (sessionIds.length === 0) return {};
  const res = await backendApi.get<{ sessions: LiveSession[] }>('/agents/sessions');
  const sessions = res.data?.sessions ?? [];
  const map: Record<string, SessionStatus> = {};
  for (const s of sessions) {
    if (sessionIds.includes(s.session_id)) {
      map[s.session_id] = s.status === 'running' ? 'running' : 'idle';
    }
  }
  return map;
}

// ─── Status icon ──────────────────────────────────────────────────────────────

function StatusIcon({ status }: { status: SessionStatus | 'pending' }) {
  if (status === 'pending') return <Loader2 className="h-4 w-4 animate-spin text-zinc-400" />;
  if (status === 'running') return <Loader2 className="h-4 w-4 animate-spin text-blue-500" />;
  if (status === 'idle') return <CheckCircle2 className="h-4 w-4 text-green-500" />;
  if (status === 'error') return <XCircle className="h-4 w-4 text-red-500" />;
  return <div className="h-4 w-4 rounded-full bg-zinc-200 dark:bg-zinc-700" />;
}

// ─── Session tile ─────────────────────────────────────────────────────────────

function SessionTile({
  session,
  status,
}: {
  session: ParallelSession;
  status: SessionStatus | 'pending';
}) {
  return (
    <div
      className={cn(
        'flex flex-col gap-2 p-4 rounded-lg border text-sm transition-colors',
        status === 'running' && 'border-blue-300 dark:border-blue-700 bg-blue-50/30 dark:bg-blue-900/10',
        status === 'idle' && 'border-green-300 dark:border-green-700 bg-green-50/30 dark:bg-green-900/10',
        status === 'error' && 'border-red-300 dark:border-red-700 bg-red-50/30 dark:bg-red-900/10',
        (status === 'pending' || status === 'unknown') && 'border-zinc-200 dark:border-zinc-800',
      )}
    >
      <div className="flex items-center gap-2">
        <StatusIcon status={status} />
        <span className="text-xs text-zinc-400 tabular-nums">#{session.index + 1}</span>
        <Badge variant="outline" className="text-xs h-5 px-1.5">
          {status === 'pending' ? 'spawning' : status}
        </Badge>
      </div>
      <p className="text-zinc-800 dark:text-zinc-200 font-medium leading-snug line-clamp-3">
        {session.task}
      </p>
      <p className="text-xs text-zinc-400 font-mono truncate">{session.session_id}</p>
    </div>
  );
}

// ─── Main panel ───────────────────────────────────────────────────────────────

export function ParallelAgentPanel({ onClose }: { onClose?: () => void }) {
  const [context, setContext] = useState('');
  const [taskInputs, setTaskInputs] = useState<string[]>(['', '', '']);
  const [spawnedSessions, setSpawnedSessions] = useState<ParallelSession[]>([]);
  const [failedSpawns, setFailedSpawns] = useState<Array<{ index: number; error: string }>>([]);
  const qc = useQueryClient();

  const spawnMutation = useMutation({
    mutationFn: () =>
      spawnParallel({
        tasks: taskInputs.filter((t) => t.trim()),
        context: context.trim() || undefined,
      }),
    onSuccess: (data) => {
      setSpawnedSessions(data.sessions);
      setFailedSpawns(data.failed);
    },
  });

  const spawnedIds = spawnedSessions.map((s) => s.session_id);
  const { data: statusMap = {} } = useQuery({
    queryKey: ['parallel-session-statuses', spawnedIds],
    queryFn: () => fetchSessionStatuses(spawnedIds),
    enabled: spawnedIds.length > 0,
    refetchInterval: 4000,
    staleTime: 2000,
  });

  const addTask = useCallback(() => setTaskInputs((prev) => [...prev, '']), []);
  const removeTask = useCallback((idx: number) => {
    setTaskInputs((prev) => prev.filter((_, i) => i !== idx));
  }, []);
  const updateTask = useCallback((idx: number, val: string) => {
    setTaskInputs((prev) => prev.map((t, i) => (i === idx ? val : t)));
  }, []);

  const validTasks = taskInputs.filter((t) => t.trim());
  const hasSpawned = spawnedSessions.length > 0;

  const handleReset = () => {
    setSpawnedSessions([]);
    setFailedSpawns([]);
    setTaskInputs(['', '', '']);
    setContext('');
    qc.removeQueries({ queryKey: ['parallel-session-statuses'] });
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-200 dark:border-zinc-800">
        <div className="flex items-center gap-2">
          <Layers className="h-5 w-5 text-zinc-600 dark:text-zinc-400" />
          <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">Parallel agents</h2>
          {hasSpawned && (
            <Badge variant="secondary" className="text-xs">
              {spawnedSessions.length} running
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          {hasSpawned && (
            <Button size="sm" variant="outline" onClick={handleReset} className="gap-1.5 h-8 text-xs">
              New batch
            </Button>
          )}
          {onClose && (
            <Button size="sm" variant="ghost" onClick={onClose} className="h-8 w-8 p-0">
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {!hasSpawned ? (
          /* Setup view */
          <div className="p-5 space-y-4">
            {/* Shared context */}
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                Shared context <span className="font-normal text-zinc-400">(optional)</span>
              </label>
              <Textarea
                placeholder="e.g. You are an expert copywriter. Write in a professional tone."
                value={context}
                onChange={(e) => setContext(e.target.value)}
                rows={2}
                className="text-sm resize-none"
              />
              <p className="text-xs text-zinc-400">Prepended to every task prompt.</p>
            </div>

            {/* Task list */}
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                Tasks <span className="text-zinc-400 font-normal">({validTasks.length} / 20)</span>
              </label>
              <div className="space-y-2">
                {taskInputs.map((task, idx) => (
                  <div key={idx} className="flex items-start gap-2">
                    <span className="text-xs text-zinc-400 tabular-nums mt-2 w-5 text-right flex-shrink-0">
                      {idx + 1}.
                    </span>
                    <Textarea
                      placeholder={`Task ${idx + 1}…`}
                      value={task}
                      onChange={(e) => updateTask(idx, e.target.value)}
                      rows={1}
                      className="flex-1 text-sm resize-none"
                    />
                    {taskInputs.length > 1 && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => removeTask(idx)}
                        className="h-8 w-8 p-0 mt-0.5 text-zinc-400 hover:text-red-500 flex-shrink-0"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>
                ))}
              </div>
              {taskInputs.length < 20 && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={addTask}
                  className="gap-1.5 h-8 text-xs"
                >
                  <Plus className="h-3.5 w-3.5" /> Add task
                </Button>
              )}
            </div>

            {/* Spawn button */}
            <Button
              onClick={() => spawnMutation.mutate()}
              disabled={validTasks.length === 0 || spawnMutation.isPending}
              className="w-full gap-2"
            >
              {spawnMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" /> Spawning {validTasks.length} agents…
                </>
              ) : (
                <>
                  <Play className="h-4 w-4" /> Run {validTasks.length} agent{validTasks.length !== 1 ? 's' : ''} in parallel
                </>
              )}
            </Button>

            {spawnMutation.error && (
              <p className="text-sm text-red-500">{(spawnMutation.error as Error).message}</p>
            )}
          </div>
        ) : (
          /* Results view */
          <div className="p-5 space-y-4">
            {/* Failed spawns */}
            {failedSpawns.length > 0 && (
              <div className="p-3 rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 space-y-1">
                <p className="text-sm font-medium text-red-700 dark:text-red-400">
                  {failedSpawns.length} task{failedSpawns.length !== 1 ? 's' : ''} failed to spawn
                </p>
                {failedSpawns.map((f) => (
                  <p key={f.index} className="text-xs text-red-600 dark:text-red-400">
                    Task #{f.index + 1}: {f.error}
                  </p>
                ))}
              </div>
            )}

            {/* Session tiles grid */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {spawnedSessions.map((session) => (
                <SessionTile
                  key={session.session_id}
                  session={session}
                  status={statusMap[session.session_id] ?? 'running'}
                />
              ))}
            </div>

            <p className="text-xs text-zinc-400 text-center">
              Sessions update every 4 seconds · {spawnedSessions.length} active
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
