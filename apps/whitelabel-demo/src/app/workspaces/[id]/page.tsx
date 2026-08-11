'use client';

import Loading from '@/components/ui/loading';

import { AgentPicker } from '@/components/chat/agent-picker';
import { ModelPicker } from '@/components/chat/model-picker';
import {
  ConnectorBindingFields,
  useConnectorBindingChoices,
} from '@/components/connector-bindings';
import { WorkspaceShell } from '@/components/workspace-shell';
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
  useWorkspaceConfig,
  useWorkspaceModels,
  useVisibleAgents,
  writeStartStash,
} from '@kortix/sdk/react';
import { ConnectRequiredCard } from '@/components/connect-required-card';
import {
  type ConnectorRequirement,
  connectorRequirement,
} from '@/lib/connector-required';
import { sessionCreateFailure } from '@/lib/session-create-failure';
import { NO_OVERRIDES, buildSessionCreateInput } from '@/lib/session-overrides';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUp, Sparkles } from 'lucide-react';
import { useParams, useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { toast } from 'sonner';

const STARTERS = [
  {
    label: 'Build a landing page',
    prompt: 'Build a clean, modern landing page for my product.',
  },
  {
    label: 'Onboard the agent',
    prompt:
      'Onboard me — ask about my company, what we do, who our customers are, and our goals, then save it to workspace memory.',
  },
  {
    label: 'Fix a bug',
    prompt: 'There is a bug in the app. Investigate it and propose a fix.',
  },
  {
    label: 'Add a feature',
    prompt: 'Add a new feature to the app — ask me what I have in mind.',
  },
];

export default function WorkspacePage() {
  return (
    <WorkspaceShell>
      <WorkspaceHome />
    </WorkspaceShell>
  );
}

function WorkspaceHome() {
  const workspaceId = String(useParams().id);
  const router = useRouter();
  const qc = useQueryClient();
  const ref = useRef<HTMLTextAreaElement>(null);

  const [prompt, setPrompt] = useState('');
  // The connector PRE-FLIGHT refusal: the session declares a connector with no
  // usable connection, so the platform refused it before a sandbox booted.
  // Shown as a call to action rather than an error, because it is one — and
  // shown HERE rather than as a toast, because the alternative the user would
  // otherwise get is a streamed agent apology they paid tokens for.
  const [connectPrompt, setConnectPrompt] =
    useState<ConnectorRequirement | null>(null);
  // Which shared connection each connector should run as. An alias absent from
  // this map keeps the connector's default, which is what an unbound alias
  // resolves to server-side anyway.
  const [bindings, setBindings] = useState<Record<string, string>>({});

  // Only workspace connections are offered: a wrapper has no personal identity
  // upstream, so a member's private connection cannot be bound at all. The
  // alias used to be hardcoded here, which meant exactly one connector could
  // ever be bound from this screen.
  const connectors = useConnectorBindingChoices(workspaceId);
  const [template, setTemplate] = useState('default');
  const [agent, setAgent] = useState<string | null>(null);
  const [model, setModel] = useState<ModelKey | null>(null);

  // Every picker is a server-side fetch — no runtime needed on this screen.
  const models = useWorkspaceModels(workspaceId);
  const agents = useVisibleAgents({ workspaceId });
  const config = useWorkspaceConfig(workspaceId);
  const templates = useQuery({
    queryKey: ['workspace-sandbox-templates', workspaceId],
    queryFn: () => kortix.workspaces.sandboxTemplates(workspaceId),
    retry: false,
  });
  // `.sandboxTemplates()` returns `{ items: SandboxTemplate[] }` — this used to
  // read a nonexistent `.templates` field (masked by an `as any` cast), so the
  // multi-template picker below never actually rendered any options.
  const templateList: SandboxTemplate[] = templates.data?.items ?? [];

  const start = useMutation({
    mutationFn: async (text: string) => {
      const sessionId = generateSessionId();
      // Template + agent + bindings are create-time; the prompt + model + agent
      // flow into the first message (stashed) so the chosen model applies at
      // start. Unset overrides are omitted by the builder rather than guessed.
      await kortix.workspace(workspaceId).sessions.create(
        buildSessionCreateInput(
          { ...NO_OVERRIDES, agent, bindings },
          {
            sessionId,
            name: text.slice(0, 60),
            sandboxSlug: template,
          },
        ),
      );
      writeStartStash(sessionId, { prompt: text, model, agent });
      kortix
        .workspace(workspaceId)
        .onboardingComplete(true)
        .catch(() => {});
      return sessionId;
    },
    onSuccess: (sessionId) => {
      invalidateSessions(qc, workspaceId);
      router.push(`/workspaces/${workspaceId}/sessions/${sessionId}`);
    },
    onError: (err: unknown) => {
      // A missing connector is the one create refusal with a real remedy, so it
      // gets the card instead of a toast. Everything else keeps the shared
      // classifier, which names the person who can fix each refusal.
      const requirement = connectorRequirement(err);
      if (requirement) {
        setConnectPrompt(requirement);
        return;
      }
      const failure = sessionCreateFailure(err);
      toast.error(failure.title, { description: failure.detail });
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
          <h1 className="text-xl font-semibold tracking-tight">
            What would you like to build?
          </h1>
          <p className="mt-1.5 text-sm text-muted-foreground">
            Pick your template, agent, and model, then describe the task.
          </p>
        </div>

        {/* Which shared account each connector runs as — every alias the
            workspace has connections for, including the ones where the honest
            answer is "a teammate has to share this first". */}
        {(connectors.data?.connectors.length ?? 0) > 0 && (
          <div className="mb-3 text-left">
            <ConnectorBindingFields
              choices={connectors.data?.connectors ?? []}
              value={bindings}
              onChange={(next) => {
                setBindings(next);
                // The card describes the bindings that were sent. Once those
                // change it is a verdict on a request that no longer exists.
                setConnectPrompt(null);
              }}
            />
          </div>
        )}

        {/* Kortix-as-a-Backend: the session declares a connector with no usable
            connection. A call to action, not a failure — and the card is honest
            about which remedies actually exist for THIS connector, rather than
            offering everyone a button that only works for shared ones. */}
        {connectPrompt && (
          <div className="mb-4">
            <ConnectRequiredCard
              workspaceId={workspaceId}
              requirement={connectPrompt}
              onRetry={() => {
                setConnectPrompt(null);
                if (prompt.trim()) start.mutate(prompt.trim());
              }}
              onDismiss={() => setConnectPrompt(null)}
            />
          </div>
        )}

        <div className="rounded-2xl border border-border bg-card shadow-sm transition-colors focus-within:border-ring/60">
          <Textarea
            ref={ref}
            rows={3}
            value={prompt}
            disabled={launching}
            placeholder="e.g. Build a personal portfolio site with a workspaces gallery…"
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
              {launching ? (
                <Loading className="size-4" />
              ) : (
                <ArrowUp className="size-4" />
              )}
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
