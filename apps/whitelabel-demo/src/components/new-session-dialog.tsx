'use client';

/**
 * Start a session with its initial scope chosen up front.
 *
 * The sidebar used to create sessions with nothing but an id, which quietly
 * made "the project default agent, the agent's full secret grant, the default
 * connection for every connector" the only session shape this app could
 * produce. This is where that initial choice happens.
 *
 * Everything is optional and every unset field is OMITTED from the create body
 * rather than sent as a guess (`buildSessionCreateInput`), so the default
 * behaviour is byte-for-byte what it was before this dialog existed.
 */

import Loading from '@/components/ui/loading';

import { AgentPicker } from '@/components/chat/agent-picker';
import { CallSnippet } from '@/components/dev/call-snippet';
import {
  ConnectorBindingFields,
  useConnectorBindingChoices,
} from '@/components/connector-bindings';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { kortix } from '@/lib/kortix';
import { invalidateSessions, qk } from '@/lib/query-keys';
import { sessionCreateFailure } from '@/lib/session-create-failure';
import {
  NO_OVERRIDES,
  type SessionOverrides,
  buildSessionCreateInput,
} from '@/lib/session-overrides';
import { generateSessionId } from '@kortix/sdk';
import { useProjectConfig, useVisibleAgents } from '@kortix/sdk/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';

export function NewSessionDialog({
  projectId,
  trigger,
  initialAgent = null,
}: {
  projectId: string;
  trigger: React.ReactNode;
  /** Pre-picked agent — used when a refused agent switch sends someone here. */
  initialAgent?: string | null;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="max-h-[85dvh] overflow-y-auto scrollbar-thin sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New session</DialogTitle>
          <DialogDescription>
            Set the initial agent, secrets, and connector authorizations. You
            can change the session scope later.
          </DialogDescription>
        </DialogHeader>
        {/* Mounted only while open so the pickers' fetches don't run on every
            page that renders the sidebar. */}
        {open && (
          <NewSessionForm
            projectId={projectId}
            initialAgent={initialAgent}
            onDone={() => setOpen(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function NewSessionForm({
  projectId,
  initialAgent,
  onDone,
}: {
  projectId: string;
  initialAgent: string | null;
  onDone: () => void;
}) {
  const router = useRouter();
  const qc = useQueryClient();

  const [agent, setAgent] = useState<string | null>(initialAgent);
  const [bindings, setBindings] = useState<Record<string, string>>({});
  // Off = send no allowlist at all, which is today's behaviour and the honest
  // default: the agent's own grant already narrows what the sandbox receives.
  const [narrowSecrets, setNarrowSecrets] = useState(false);
  const [allowed, setAllowed] = useState<string[] | null>(null);

  const agents = useVisibleAgents({ projectId });
  const config = useProjectConfig(projectId);
  const connectors = useConnectorBindingChoices(projectId);
  const secrets = useQuery({
    queryKey: qk.secrets(projectId),
    queryFn: () => kortix.project(projectId).secrets.list(),
    retry: false,
  });

  // The allowlist is by IDENTIFIER, not by env KEY: two identifiers can inject
  // the same key, which is exactly the collision the server rejects (409).
  const identifiers = (secrets.data?.items ?? []).map((secret) => ({
    identifier: secret.identifier,
    name: secret.name,
  }));
  // Default to NOTHING checked rather than everything.
  //
  // Pre-checking every listed row looks helpful and makes create fail on two
  // ordinary projects. `GET /secrets` lists rows of every scope, but create
  // validates the allowlist against runtime-scoped rows only — so a project with
  // a Teams/Slack install (whose install rows are `scope:'connector'`) gets
  // 404 SECRET_IDENTIFIER_NOT_FOUND. And two identifiers may legally share one
  // env KEY, which is exactly the 409 SECRET_IDENTIFIER_KEY_COLLISION the server
  // rejects — so pre-checking both guarantees it.
  //
  // An empty allowlist is also the honest default for a control whose whole
  // point is narrowing: the user picks what to expose, rather than un-picking
  // from a set the server may refuse.
  const checked = allowed ?? [];

  const overrides: SessionOverrides = {
    ...NO_OVERRIDES,
    agent,
    bindings,
    secrets: narrowSecrets ? checked : null,
  };

  const start = useMutation({
    mutationFn: async () => {
      const sessionId = generateSessionId();
      await kortix.project(projectId).sessions.create(
        buildSessionCreateInput(overrides, {
          sessionId,
        }),
      );
      return sessionId;
    },
    onSuccess: (sessionId) => {
      invalidateSessions(qc, projectId);
      onDone();
      router.push(`/projects/${projectId}/sessions/${sessionId}`);
    },
    onError: (err) => {
      // Each KaaB refusal has a distinct code and a different person who can
      // fix it — collapsing them into one string threw that away.
      const failure = sessionCreateFailure(err);
      toast.error(failure.title, { description: failure.detail });
    },
  });

  const toggle = (identifier: string, on: boolean) => {
    const next = on
      ? [...new Set([...checked, identifier])]
      : checked.filter((id) => id !== identifier);
    setAllowed(next);
  };

  return (
    <div className="space-y-5">
      <section className="space-y-1.5">
        <Label>Agent</Label>
        <div className="flex items-center gap-2">
          <AgentPicker
            agents={agents}
            value={agent}
            onChange={setAgent}
            defaultName={config?.default_agent}
          />
          {agents.length === 0 && (
            <span className="text-xs text-muted-foreground">
              This project runs its default agent.
            </span>
          )}
        </div>
      </section>

      <section className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <Label htmlFor="narrow-secrets">
              Limit which secrets this session can read
            </Label>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Off, the session gets the agent&apos;s full secret grant. An
              allowlist only ever narrows it. You can replace the allowlist
              after the session starts.
            </p>
          </div>
          <Switch
            id="narrow-secrets"
            checked={narrowSecrets}
            onCheckedChange={setNarrowSecrets}
            disabled={secrets.isLoading || identifiers.length === 0}
          />
        </div>
        {secrets.isLoading && <Skeleton className="h-8 w-full" />}
        {narrowSecrets && (
          <div className="space-y-1.5 rounded-md border border-border bg-muted/30 p-3">
            {identifiers.map((secret) => (
              <div
                key={secret.identifier}
                className="flex items-center justify-between gap-3"
              >
                <Label
                  htmlFor={`secret-${secret.identifier}`}
                  className="min-w-0 font-mono text-xs font-normal"
                >
                  <span className="truncate">{secret.identifier}</span>
                  {secret.name !== secret.identifier && (
                    <span className="truncate text-muted-foreground">
                      → {secret.name}
                    </span>
                  )}
                </Label>
                <Switch
                  id={`secret-${secret.identifier}`}
                  checked={checked.includes(secret.identifier)}
                  onCheckedChange={(on) => toggle(secret.identifier, on)}
                />
              </div>
            ))}
            {checked.length === 0 && (
              <p className="text-xs text-muted-foreground">
                This session will receive no project secrets at all.
              </p>
            )}
          </div>
        )}
      </section>

      {(connectors.data?.connectors.length ?? 0) > 0 && (
        <section className="space-y-2">
          <div>
            <Label>Connections</Label>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Which shared account each connector acts as. Sessions started here
              can only use project connections.
            </p>
          </div>
          <ConnectorBindingFields
            choices={connectors.data?.connectors ?? []}
            value={bindings}
            onChange={setBindings}
          />
          {/* Where the options in that picker come from — including why an
              alias can be listed with nothing to choose. */}
          <CallSnippet id="connections.list" context={{ projectId }} />
        </section>
      )}

      {/* The dialog IS the create body — so show the body it currently builds,
          updating as the switches move, rather than describing it. */}
      <CallSnippet
        id="session.create"
        context={{
          projectId,
          overrides,
        }}
      />

      <DialogFooter>
        <Button variant="ghost" onClick={onDone} disabled={start.isPending}>
          Cancel
        </Button>
        <Button onClick={() => start.mutate()} disabled={start.isPending}>
          {start.isPending && <Loading className="size-4" />}
          Start session
        </Button>
      </DialogFooter>
    </div>
  );
}
