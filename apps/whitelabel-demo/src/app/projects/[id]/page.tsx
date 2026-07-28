'use client';

import Loading from '@/components/ui/loading';

import { AgentPicker } from '@/components/chat/agent-picker';
import { ModelPicker } from '@/components/chat/model-picker';
import { ProjectShell } from '@/components/project-shell';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
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
import { classifySessionStartFailure } from '@/lib/session-start-error';
import type { BindableConnection } from '@/server/bindable-connections';
import { getSessionToken } from '@/lib/session';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUp, Sparkles } from 'lucide-react';
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
  // A connector this end-user must connect THEMSELVES before the session can
  // start (409 CONNECTOR_CONNECTION_REQUIRED). Shown as a call to action rather
  // than an error, because it is one.
  const [connectPrompt, setConnectPrompt] = useState<{
    connector: string;
    message: string;
  } | null>(null);
  // Which shared connection this session should run as. Unset = the connector's
  // default, which is what an unbound alias resolves to server-side anyway.
  const [boundConnection, setBoundConnection] = useState<string | null>(null);

  // Only TEAM connections are offered: a wrapper has no personal identity
  // upstream, so a member's private connection cannot be bound at all.
  const connections = useQuery({
    queryKey: ['bindable-connections', projectId],
    queryFn: async () => {
      const token = getSessionToken();
      const res = await fetch(
        `/api/connections?projectId=${encodeURIComponent(projectId)}&connector=gmail`,
        { headers: token ? { Authorization: `Bearer ${token}` } : undefined },
      );
      if (!res.ok) return { connections: [] as BindableConnection[] };
      return (await res.json()) as { connections: BindableConnection[] };
    },
    staleTime: 60_000,
    retry: false,
  });
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
        // connector_bindings names the exact connection this session runs as.
        // Omitted entirely when unset, so the server's default resolution applies
        // rather than us guessing at it.
        ...(boundConnection
          ? { connector_bindings: { gmail: { profile_id: boundConnection } } }
          : {}),
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
    onError: (err: unknown) => {
      // Two KaaB refusals need opposite responses, and a single generic toast
      // told the user to fix something they often could not fix.
      const body =
        err && typeof err === 'object' && 'body' in err
          ? ((err as { body?: unknown }).body as Record<string, unknown> | null)
          : null;
      const failure = classifySessionStartFailure(body);
      if (failure.kind === 'connector_connection_required') {
        setConnectPrompt({ connector: failure.connector, message: failure.message });
        return;
      }
      if (failure.kind === 'require_connectors_backend_origin') {
        // Developer-facing: the end-user can do nothing about this.
        toast.error(failure.message, { duration: 10_000 });
        return;
      }
      toast.error(failure.message);
    },
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

        {/* Which shared connection this session runs as. Only shown when there
            is a genuine choice — one connection means the default is the only
            answer, and a picker with a single option is noise. */}
        {(connections.data?.connections.length ?? 0) > 1 && (
          <div className="mb-3 flex items-center gap-2 text-left">
            <span className="text-xs text-muted-foreground">Run as</span>
            <Select
              value={boundConnection ?? 'default'}
              onValueChange={(v) => setBoundConnection(v === 'default' ? null : v)}
            >
              <SelectTrigger className="h-7 w-auto gap-1.5 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="default">Default connection</SelectItem>
                {connections.data?.connections.map((connection) => (
                  <SelectItem key={connection.profileId} value={connection.profileId}>
                    {connection.label}
                    {connection.isDefault ? ' (default)' : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {/* Kortix-as-a-Backend: the session needs THIS end-user's own connection.
            A call to action, not a failure — they can resolve it themselves,
            and the previous generic toast gave them nothing to act on. */}
        {connectPrompt && (
          <div className="mb-4 rounded-2xl border border-brand/40 bg-brand/5 p-4 text-left">
            <div className="text-sm font-medium">
              Connect {connectPrompt.connector} to continue
            </div>
            <p className="mt-1 text-sm text-muted-foreground">{connectPrompt.message}</p>
            <div className="mt-3 flex items-center gap-2">
              <Button
                size="sm"
                onClick={() => {
                  setConnectPrompt(null);
                  if (prompt.trim()) start.mutate(prompt);
                }}
              >
                I&apos;ve connected it — retry
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConnectPrompt(null)}>
                Dismiss
              </Button>
            </div>
          </div>
        )}

        <div className="rounded-2xl border border-border bg-card shadow-sm transition-colors focus-within:border-ring/60">
          <Textarea
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
            className="min-h-[84px] resize-none border-0 bg-transparent px-4 pt-3.5 text-sm leading-relaxed shadow-none focus-visible:ring-0 scrollbar-thin"
          />
          <div className="flex flex-wrap items-center gap-1.5 px-2.5 pb-2.5">
            <ModelPicker models={models} value={model} onChange={setModel} />
            <AgentPicker
              agents={agents}
              value={agent}
              onChange={setAgent}
              defaultName={config?.default_agent}
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
              {launching ? <Loading className="size-4" /> : <ArrowUp className="size-4" />}
            </Button>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap justify-center gap-2">
          {STARTERS.map((s) => (
            <Button
              key={s.label}
              type="button"
              variant="outline"
              size="sm"
              disabled={launching}
              onClick={() => {
                setPrompt(s.prompt);
                ref.current?.focus();
              }}
              className="h-7 rounded-full bg-card text-xs text-muted-foreground"
            >
              {s.label}
            </Button>
          ))}
        </div>
      </div>
    </div>
  );
}
