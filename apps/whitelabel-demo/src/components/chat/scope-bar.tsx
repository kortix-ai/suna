'use client';

/**
 * The session's scope, under the composer where the work happens.
 *
 * Everything here was previously answerable only in a dialog seen once before
 * the session existed, or in a tab nobody opens mid-conversation — so "can this
 * agent read the Stripe key?" and "which mailbox is it sending as?" were
 * questions with no answer at the moment they get asked.
 *
 * The scope endpoint is authoritative for secrets and connector bindings. Each
 * save reads that scope and sends a complete replacement for both axes.
 *
 * This file is the orchestration: the queries, the draft state, the two
 * mutations, and the three chips. The chips' bodies live beside it — the
 * secrets chip in `secrets-scope-chip.tsx`, the connections chip in
 * `connections-scope-chip.tsx`, the shared primitives in `chip.tsx`.
 */

import { Cpu, Bot } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';

import { useConnectorBindingChoices } from '@/components/connector-bindings';
import { ScopeChip, StartWithScope } from '@/components/chat/scope-bar/chip';
import { ConnectionsScopeChip } from '@/components/chat/scope-bar/connections-scope-chip';
import { SecretsScopeChip } from '@/components/chat/scope-bar/secrets-scope-chip';
import { ModelSwitcher } from '@/components/workbench/model-switcher';
import { kortix } from '@/lib/kortix';
import { qk } from '@/lib/query-keys';
import { useSessionModel } from '@/lib/session-model';
import { useCreateSession } from '@/lib/use-create-session';
import {
  buildCompleteSessionScopeReplacement,
  readScopeBindingIds,
  sessionScopeIsReadable,
} from '@/lib/session-scope';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  scopeBarConnectors,
  scopeBarSecrets,
  scopeControl,
  scopeDraftIssues,
} from './scope-bar-model';

export function ScopeBar({
  projectId,
  sessionId,
}: {
  projectId: string;
  sessionId: string;
}) {
  const router = useRouter();
  const qc = useQueryClient();

  const session = useQuery({
    queryKey: qk.session(projectId, sessionId),
    queryFn: () =>
      kortix.session(projectId, sessionId).get({ showErrors: false }),
    retry: false,
  });
  const secrets = useQuery({
    queryKey: qk.secrets(projectId),
    queryFn: () => kortix.project(projectId).secrets.list(),
    retry: false,
  });
  const scope = useQuery({
    queryKey: qk.sessionScope(projectId, sessionId),
    queryFn: () => kortix.session(projectId, sessionId).scope(),
    retry: false,
  });
  const connectors = useConnectorBindingChoices(projectId);
  // The switcher inside the popover shares this hook's cache entry, so this
  // label is the switcher's own answer rather than a second opinion — and it
  // costs no second request.
  const model = useSessionModel(projectId, sessionId);

  // A redacted session arrives as a perfectly good HTTP 200 with
  // `secrets_allowlist: null` — the exact value that means "not narrowed". Read
  // it as fact and a session the viewer may NOT open renders as the LEAST
  // restricted one on the screen.
  const data = sessionScopeIsReadable(session.data) ? session.data : null;
  const authoritativeScope = scope.data;

  const items = secrets.data?.items ?? [];
  const choices = connectors.data?.connectors ?? [];
  const live = scopeBarSecrets({
    secrets: items,
    allowlist: authoritativeScope?.secrets_allowlist,
  });
  const liveBindings = readScopeBindingIds(
    authoritativeScope?.connector_bindings,
  );
  const connections = scopeBarConnectors({
    choices: connectors.data?.connectors,
    boundConnections: liveBindings,
  });

  // `undefined` = untouched, so the draft simply IS this session's scope until
  // someone changes something. Deriving it instead of copying it in an effect
  // keeps it correct while the session query is still resolving.
  const [draftSecrets, setDraftSecrets] = useState<string[] | null | undefined>(
    undefined,
  );
  const [draftBindings, setDraftBindings] = useState<
    Record<string, string> | undefined
  >(undefined);

  const nextSecrets =
    draftSecrets === undefined
      ? (authoritativeScope?.secrets_allowlist ?? null)
      : draftSecrets;
  const nextBindings = draftBindings ?? liveBindings;
  const issues = scopeDraftIssues(nextSecrets ?? [], items);

  const start = useCreateSession(projectId, {
    input: () => ({
      // The agent comes along too, or "with this scope" would quietly drop
      // the one part of the scope that is already right.
      overrides: {
        agent: data?.agent_name ?? null,
        secrets: nextSecrets,
        bindings: nextBindings,
        runtimeContext: null,
      },
    }),
    onCreated: (nextId) => {
      router.push(`/projects/${projectId}/sessions/${nextId}`);
    },
  });

  // Apply the draft to THIS session. The bar said "Changeable" before this
  // existed — a badge without the control, which is worse than saying frozen.
  const applyScope = useMutation({
    mutationFn: async (patch: {
      secrets?: string[] | null;
      bindings?: Record<string, string>;
    }) => {
      if (!authoritativeScope) {
        throw new Error('The current session scope is not available');
      }
      return kortix
        .session(projectId, sessionId)
        .rescope(
          buildCompleteSessionScopeReplacement(authoritativeScope, patch),
        );
    },
    onSuccess: (body) => {
      // Report what actually happened, not a flat "saved". A dropped secret stops
      // being DELIVERED from the next prompt — the agent may still hold the value
      // it already read, and saying "revoked" here would be false assurance.
      // Only a dropped SECRET carries the "cannot un-read" caveat. A dropped
      // BINDING is fully retroactive, so warning about it would teach a limit
      // that does not exist there.
      const dropped = body.dropped_secrets ?? [];
      if (dropped.length > 0 && body.retroactive === false) {
        toast.warning(body.detail ?? 'Applies from the next prompt.', {
          duration: 8000,
        });
      } else {
        toast.success(
          body.detail ?? 'Scope updated — applies from the next prompt.',
        );
      }
      qc.setQueryData(qk.sessionScope(projectId, sessionId), body);
      setDraftSecrets(undefined);
      setDraftBindings(undefined);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  // Every chip is a claim about what this session may reach, and a half-loaded
  // one reads as a narrower session than it is ("None" before the list arrives).
  // Hold the whole bar rather than animating through a wrong answer.
  if (
    session.isLoading ||
    scope.isLoading ||
    secrets.isLoading ||
    connectors.isLoading
  ) {
    return <div className="mt-2 h-6" aria-hidden />;
  }
  if (!data || !authoritativeScope) {
    return (
      <p className="mt-2 text-center text-[11px] text-muted-foreground">
        This session's scope could not be read just now.
      </p>
    );
  }

  // Offering "start a new session with this scope" against a secret list that
  // failed to load would either send an allowlist nothing verified or refuse it
  // with a reason that is only an artefact of the failed read.
  const startAction = secrets.isError ? null : (
    <StartWithScope
      issues={issues.map((issue) => issue.message)}
      pending={start.isPending}
      onStart={() => start.mutate()}
    />
  );

  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      <SecretsScopeChip
        projectId={projectId}
        sessionId={sessionId}
        authoritativeScope={authoritativeScope}
        items={items}
        secretsError={secrets.isError}
        live={live}
        issues={issues}
        draft={draftSecrets}
        nextSecrets={nextSecrets}
        setDraftSecrets={setDraftSecrets}
        applyScope={applyScope}
        startAction={startAction}
      />

      <ConnectionsScopeChip
        projectId={projectId}
        sessionId={sessionId}
        connections={connections}
        choices={choices}
        draft={draftBindings}
        nextBindings={nextBindings}
        setDraftBindings={setDraftBindings}
        applyScope={applyScope}
        startAction={startAction}
      />

      <ScopeChip
        icon={<Cpu className="size-3" />}
        label="Model"
        value={model.data?.model ?? 'Project default'}
        title="Model"
        badge={scopeControl('model').badge}
        note={scopeControl('model').note}
      >
        <div className="-ml-2 mt-2">
          <ModelSwitcher projectId={projectId} sessionId={sessionId} />
        </div>
      </ScopeChip>
    </div>
  );
}
