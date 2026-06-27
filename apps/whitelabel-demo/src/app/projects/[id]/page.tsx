'use client';

import { ProjectShell } from '@/components/project-shell';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { kortix } from '@/lib/kortix';
import { invalidateSessions } from '@/lib/query-keys';
import { startStashKey, type StartStash } from '@/lib/session-start';
import { cn } from '@/lib/utils';
import {
  flattenModels,
  projectLlmCatalogToProviderList,
  useVisibleAgents,
  type FlatModel,
} from '@kortix/sdk/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUp, Bot, Check, ChevronsUpDown, Cpu, Loader2, Sparkles } from 'lucide-react';
import { useParams, useRouter } from 'next/navigation';
import { useMemo, useRef, useState } from 'react';
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
  const [agentName, setAgentName] = useState('');
  const [model, setModel] = useState<FlatModel | null>(null);

  // All three pickers come from project-level REST — no runtime needed yet.
  // Agents are a SERVER-SIDE fetch (project config), shared with the workbench.
  const agents = useVisibleAgents({ projectId });
  const catalog = useQuery({
    queryKey: ['project-llm-catalog', projectId],
    queryFn: () => kortix.project(projectId).llmCatalog(),
    retry: false,
  });
  const templates = useQuery({
    queryKey: ['project-sandbox-templates', projectId],
    queryFn: () => kortix.projects.sandboxTemplates(projectId),
    retry: false,
  });
  const models = useMemo(
    () => (catalog.data ? flattenModels(projectLlmCatalogToProviderList(catalog.data as any)) : []),
    [catalog.data],
  );
  const templateList = ((templates.data as any)?.templates ??
    (Array.isArray(templates.data) ? templates.data : [])) as any[];

  const start = useMutation({
    mutationFn: async (text: string) => {
      const sessionId = crypto.randomUUID();
      // Template + agent are create-time; prompt + model + agent flow into the
      // first message (stashed) so the chosen model actually applies at start.
      await kortix.project(projectId).sessions.create({
        session_id: sessionId,
        name: text.slice(0, 60),
        ...(template && template !== 'default' ? { sandbox_slug: template } : {}),
        ...(agentName ? { agent_name: agentName } : {}),
      });
      const stash: StartStash = {
        prompt: text,
        model: model ? { providerID: model.providerID, modelID: model.modelID } : null,
        agent: agentName || null,
      };
      try {
        sessionStorage.setItem(startStashKey(sessionId), JSON.stringify(stash));
      } catch {}
      kortix.project(projectId).onboardingComplete(true).catch(() => {});
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
            <ModelSelect models={models} value={model} onChange={setModel} />
            <AgentSelect agents={agents} value={agentName} onChange={setAgentName} />
            {templateList.length > 1 && (
              <Select value={template} onValueChange={setTemplate}>
                <SelectTrigger className="h-7 w-auto gap-1 border-0 bg-transparent text-xs text-muted-foreground shadow-none">
                  <SelectValue placeholder="Template" />
                </SelectTrigger>
                <SelectContent>
                  {templateList.map((t) => {
                    const slug = String(t.slug ?? t.id ?? t.name ?? 'default');
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

function ModelSelect({
  models,
  value,
  onChange,
}: {
  models: FlatModel[];
  value: FlatModel | null;
  onChange: (m: FlatModel | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  if (models.length === 0) return null;
  const filtered = (
    query
      ? models.filter((m) => `${m.modelName} ${m.providerName}`.toLowerCase().includes(query.toLowerCase()))
      : models
  ).slice(0, 60);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className="h-7 max-w-[170px] gap-1 px-2 text-xs text-muted-foreground">
          <Cpu className="size-3.5 shrink-0" />
          <span className="truncate">{value?.modelName ?? 'Model'}</span>
          <ChevronsUpDown className="size-3 shrink-0 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-0">
        <div className="border-b border-border p-2">
          <Input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search models…" className="h-8 text-xs" />
        </div>
        <div className="max-h-72 overflow-y-auto p-1 scrollbar-thin">
          {filtered.map((m) => {
            const selected = value?.providerID === m.providerID && value?.modelID === m.modelID;
            return (
              <button
                key={`${m.providerID}/${m.modelID}`}
                type="button"
                onClick={() => {
                  onChange(m);
                  setOpen(false);
                  setQuery('');
                }}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm">{m.modelName}</div>
                  <div className="truncate text-xs text-muted-foreground">{m.providerName}</div>
                </div>
                {selected && <Check className="size-4 shrink-0 text-brand" />}
              </button>
            );
          })}
          {filtered.length === 0 && (
            <div className="px-2 py-3 text-center text-xs text-muted-foreground">No models match.</div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function AgentSelect({
  agents,
  value,
  onChange,
}: {
  agents: any[];
  value: string;
  onChange: (name: string) => void;
}) {
  if (agents.length === 0) return null;
  return (
    <Select value={value || 'default'} onValueChange={(v) => onChange(v === 'default' ? '' : v)}>
      <SelectTrigger className="h-7 w-auto gap-1 border-0 bg-transparent text-xs text-muted-foreground shadow-none">
        <Bot className="size-3.5" />
        <SelectValue placeholder="Agent" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="default">Default agent</SelectItem>
        {agents.map((a) => (
          <SelectItem key={a.name} value={a.name} className="capitalize">
            {a.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
