'use client';

import { Button, Card, Spinner, Textarea } from '@/components/ui';
import { kortix } from '@/lib/kortix';
import { cn, relativeTime } from '@/lib/utils';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ArrowUp, MessageSquarePlus } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';

const STATUS_DOT: Record<string, string> = {
  running: 'bg-emerald-400',
  provisioning: 'bg-amber-400 animate-pulse',
  branching: 'bg-amber-400 animate-pulse',
  queued: 'bg-amber-400 animate-pulse',
  completed: 'bg-[var(--color-muted)]',
  stopped: 'bg-[var(--color-muted)]',
  failed: 'bg-red-400',
};

export default function ProjectPage() {
  const params = useParams();
  const projectId = String(params.id);
  const router = useRouter();
  const qc = useQueryClient();
  const [prompt, setPrompt] = useState('');

  const project = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => kortix.project(projectId).get(),
  });
  const sessions = useQuery({
    queryKey: ['project-sessions', projectId],
    queryFn: () => kortix.project(projectId).sessions.list(),
    refetchInterval: 5_000,
  });

  const startSession = useMutation({
    mutationFn: async (initialPrompt: string | null) => {
      const sessionId = crypto.randomUUID();
      await kortix.project(projectId).sessions.create({
        session_id: sessionId,
        ...(initialPrompt
          ? { initial_prompt: initialPrompt, name: initialPrompt.slice(0, 60) }
          : {}),
      });
      return sessionId;
    },
    onSuccess: (sessionId) => {
      qc.invalidateQueries({ queryKey: ['project-sessions', projectId] });
      router.push(`/projects/${projectId}/sessions/${sessionId}`);
    },
    onError: () => toast.error('Could not start a session'),
  });

  const items = sessions.data ?? [];
  const launching = startSession.isPending;

  return (
    <div className="mx-auto min-h-dvh max-w-3xl px-5 py-6">
      <header className="flex items-center gap-3">
        <Link href="/">
          <Button variant="ghost" size="icon" aria-label="Back">
            <ArrowLeft className="size-4" />
          </Button>
        </Link>
        <div className="min-w-0">
          <h1 className="truncate text-lg font-semibold tracking-tight text-[var(--color-fg)]">
            {project.data?.name ?? 'Project'}
          </h1>
          {project.data?.repo_url && (
            <p className="truncate text-xs text-[var(--color-muted)]">{project.data.repo_url}</p>
          )}
        </div>
      </header>

      {/* New session composer */}
      <Card className="mt-6 p-3">
        <div className="relative">
          <Textarea
            rows={2}
            value={prompt}
            disabled={launching}
            placeholder="Describe a task to start a new agent session…"
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                if (prompt.trim()) startSession.mutate(prompt.trim());
              }
            }}
            className="min-h-[64px] pr-14"
          />
          <div className="absolute bottom-2.5 right-2.5">
            <Button
              size="icon"
              disabled={!prompt.trim() || launching}
              onClick={() => startSession.mutate(prompt.trim())}
              aria-label="Start session"
            >
              {launching ? <Spinner className="text-current" /> : <ArrowUp className="size-4" />}
            </Button>
          </div>
        </div>
        <div className="mt-2 flex justify-end">
          <Button
            variant="ghost"
            size="sm"
            disabled={launching}
            onClick={() => startSession.mutate(null)}
          >
            <MessageSquarePlus className="size-4" /> Blank session
          </Button>
        </div>
      </Card>

      {/* Sessions list */}
      <div className="mt-6">
        <h2 className="text-sm font-medium text-[var(--color-muted)]">Sessions</h2>
        <div className="mt-3 space-y-2">
          {sessions.isLoading && (
            <div className="flex items-center gap-2 py-6 text-sm text-[var(--color-muted)]">
              <Spinner /> Loading sessions…
            </div>
          )}
          {sessions.isSuccess && items.length === 0 && (
            <Card className="p-6 text-center text-sm text-[var(--color-muted)]">
              No sessions yet. Start one above.
            </Card>
          )}
          {items.map((s) => (
            <Link key={s.session_id} href={`/projects/${projectId}/sessions/${s.session_id}`}>
              <Card className="flex items-center gap-3 p-3.5 transition-colors hover:bg-[var(--color-panel-2)]">
                <span
                  className={cn(
                    'size-2 shrink-0 rounded-full',
                    STATUS_DOT[s.status] ?? 'bg-[var(--color-muted)]',
                  )}
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-[var(--color-fg)]">
                    {s.name || s.custom_name || s.branch_name || 'Untitled session'}
                  </div>
                  <div className="truncate text-xs text-[var(--color-muted)]">
                    {s.status} · {relativeTime(s.updated_at)}
                  </div>
                </div>
              </Card>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
