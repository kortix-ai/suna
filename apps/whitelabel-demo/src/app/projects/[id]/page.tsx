'use client';

import { ProjectShell } from '@/components/project-shell';
import { Button } from '@/components/ui/button';
import { kortix } from '@/lib/kortix';
import { invalidateSessions } from '@/lib/query-keys';
import { cn } from '@/lib/utils';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowUp, Loader2, Sparkles } from 'lucide-react';
import { useParams, useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { toast } from 'sonner';

const STARTERS = [
  { label: 'Build a landing page', prompt: 'Build a clean, modern landing page for my product.' },
  {
    label: 'Onboard the agent',
    prompt:
      'Onboard me — ask about my company, what we do, who our customers are, and our goals, then save it to project memory.',
  },
  { label: 'Fix a bug', prompt: 'There is a bug in the app. Investigate it and propose a fix.' },
  { label: 'Add a feature', prompt: 'Add a new feature to the app — ask me what I have in mind.' },
];

export default function ProjectPage() {
  return (
    <ProjectShell>
      <ProjectHome />
    </ProjectShell>
  );
}

function ProjectHome() {
  const params = useParams();
  const projectId = String(params.id);
  const router = useRouter();
  const qc = useQueryClient();
  const [prompt, setPrompt] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

  const start = useMutation({
    mutationFn: async (initialPrompt: string) => {
      const sessionId = crypto.randomUUID();
      await kortix.project(projectId).sessions.create({
        session_id: sessionId,
        initial_prompt: initialPrompt,
        name: initialPrompt.slice(0, 60),
      });
      return sessionId;
    },
    onSuccess: (sessionId) => {
      invalidateSessions(qc, projectId);
      router.push(`/projects/${projectId}/sessions/${sessionId}`);
    },
    onError: () => toast.error('Could not start a session'),
  });

  const launching = start.isPending;

  return (
    <div className="grid flex-1 place-items-center overflow-y-auto px-6 py-10">
      <div className="w-full max-w-xl">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-4 grid size-11 place-items-center rounded-2xl bg-brand/10">
            <Sparkles className="size-5 text-brand" />
          </div>
          <h1 className="text-xl font-semibold tracking-tight">What would you like to build?</h1>
          <p className="mt-1.5 text-sm text-muted-foreground">
            Describe a task and the agent will start a session, ask anything it needs, and get to
            work.
          </p>
        </div>

        <div className="rounded-2xl border border-border bg-card shadow-sm transition-colors focus-within:border-ring/60">
          <textarea
            ref={ref}
            rows={3}
            value={prompt}
            disabled={launching}
            placeholder="e.g. Build a personal portfolio site with a projects gallery…"
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                if (prompt.trim()) start.mutate(prompt.trim());
              }
            }}
            className="min-h-[88px] w-full resize-none bg-transparent px-4 pt-3.5 text-sm leading-relaxed outline-none placeholder:text-muted-foreground scrollbar-thin"
          />
          <div className="flex justify-end px-2.5 pb-2.5">
            <Button
              size="icon"
              className="size-8 rounded-full"
              disabled={!prompt.trim() || launching}
              onClick={() => start.mutate(prompt.trim())}
              aria-label="Start session"
            >
              {launching ? <Loader2 className="size-4 animate-spin" /> : <ArrowUp className="size-4" />}
            </Button>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap justify-center gap-2">
          {STARTERS.map((s) => (
            <button
              key={s.label}
              type="button"
              disabled={launching}
              onClick={() => {
                setPrompt(s.prompt);
                ref.current?.focus();
              }}
              className={cn(
                'rounded-full border border-border bg-card px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
              )}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
