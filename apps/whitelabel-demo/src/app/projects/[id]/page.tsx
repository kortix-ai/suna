'use client';

import { AgentPicker } from '@/components/chat/agent-picker';
import { ModelPicker } from '@/components/chat/model-picker';
import { ProjectShell } from '@/components/project-shell';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { kortix } from '@/lib/kortix';
import { invalidateSessions } from '@/lib/query-keys';
import { generateSessionId, type SandboxTemplate } from '@kortix/sdk';
import {
  type ModelKey,
  useProjectConfig,
  useProjectModels,
  useVisibleAgents,
  writeStartStash,
} from '@kortix/sdk/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
  const projectId = String(useParams().id);
  const router = useRouter();
  const qc = useQueryClient();
  const ref = useRef<HTMLTextAreaElement>(null);

  const [prompt, setPrompt] = useState('');
  const [template, setTemplate] = useState('default');
  const [agent, setAgent] = useState<string | null>(null);
  const [model, setModel] = useState<ModelKey | null>(null);

  // Every picker is a server-side fetch — no runtime needed on this screen.
  const models = useProjectModels(projectId);
  const agents = useVisibleAgents({ projectId });
  const config = useProjectConfig(projectId);
  const templates = useQuery({
    queryKey: ['project-sandbox-templates', projectId],
    queryFn: () => kortix.projects.sandboxTemplates(projectId),
    retry: false,
  });
  // `.sandboxTemplates()` returns `{ items: SandboxTemplate[] }` — this used to
  // read a nonexistent `.templates` field (masked by an `as any` cast), so the
  // multi-template picker below never actually rendered any options.
  const templateList: SandboxTemplate[] = templates.data?.items ?? [];

  const start = useMutation({
    mutationFn: async (text: string) => {
      const sessionId = generateSessionId();
      // Template + agent are create-time; the prompt + model + agent flow into
      // the first message (stashed) so the chosen model applies at start.
      await kortix.project(projectId).sessions.create({
        session_id: sessionId,
        name: text.slice(0, 60),
        ...(template && template !== 'default' ? { sandbox_slug: template } : {}),
        ...(agent ? { agent_name: agent } : {}),
      });
      writeStartStash(sessionId, { prompt: text, model, agent });
      kortix
        .project(projectId)
        .onboardingComplete(true)
        .catch(() => {});
      return sessionId;
    },
    onSuccess: (sessionId) => {
      invalidateSessions(qc, projectId);
      router.push(`/projects/${projectId}/sessions/${sessionId}`);
    },
    onError: () => toast.error('Could not start a session'),
  });

  const launching = start.isPending;
  const submit = () => prompt.trim() && start.mutate(prompt.trim());

  return (
    <div className="grid flex-1 place-items-center overflow-y-auto px-6 py-10">
      <div className="w-full max-w-xl">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-4 grid size-11 place-items-center rounded-2xl bg-brand/10">
            <Sparkles className="size-5 text-brand" />
          </div>
          <h1 className="text-xl font-semibold tracking-tight">What would you like to build?</h1>
          <p className="mt-1.5 text-sm text-muted-foreground">
            Pick your template, agent, and model, then describe the task.
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
                submit();
              }
            }}
            className="min-h-[84px] w-full resize-none bg-transparent px-4 pt-3.5 text-sm leading-relaxed outline-none placeholder:text-muted-foreground scrollbar-thin"
          />
          <div className="flex flex-wrap items-center gap-1.5 px-2.5 pb-2.5">
            <ModelPicker models={models} value={model} onChange={setModel} />
            <AgentPicker
              agents={agents}
              value={agent}
              onChange={setAgent}
              defaultName={config?.open_code_default_agent}
            />
            {templateList.length > 1 && (
              <Select value={template} onValueChange={setTemplate}>
                <SelectTrigger className="h-7 w-auto gap-1 border-0 bg-transparent text-xs text-muted-foreground shadow-none">
                  <SelectValue placeholder="Template" />
                </SelectTrigger>
                <SelectContent>
                  {templateList.map((t) => {
                    const slug = t.slug || 'default';
                    return (
                      <SelectItem key={slug} value={slug}>
                        {t.name ?? slug}
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
            )}
            <div className="flex-1" />
            <Button
              size="icon"
              className="size-8 rounded-full"
              disabled={!prompt.trim() || launching}
              onClick={submit}
              aria-label="Start session"
            >
              {launching ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <ArrowUp className="size-4" />
              )}
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
              className="rounded-full border border-border bg-card px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
