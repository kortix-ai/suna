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
 */

import { CallSnippet } from '@/components/dev/call-snippet';
import Loading from '@/components/ui/loading';

import {
  ConnectorBindingFields,
  useConnectorBindingChoices,
} from '@/components/connector-bindings';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Switch } from '@/components/ui/switch';
import { ModelSwitcher } from '@/components/workbench/model-switcher';
import { kortix } from '@/lib/kortix';
import { invalidateSessions, qk } from '@/lib/query-keys';
import { getSessionToken } from '@/lib/session';
import { sessionCreateFailure } from '@/lib/session-create-failure';
import { buildSessionCreateInput } from '@/lib/session-overrides';
import {
  buildCompleteSessionScopeReplacement,
  readScopeBindingIds,
  sessionScopeIsReadable,
} from '@/lib/session-scope';
import { generateSessionId } from '@kortix/sdk';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  Bot,
  ChevronDown,
  Cpu,
  Lock,
  Plug,
  Plus,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { type ReactNode, useState } from 'react';
import { toast } from 'sonner';
import {
  MISSING_SECRET_NOTE,
  NEW_IDENTIFIER_HINT,
  SECRET_MEMBERSHIP_LABEL,
  START_NEW_SESSION_ACTION,
  classifyTypedIdentifier,
  hasScopeDraft,
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
  // Same query key the switcher inside the popover uses, so this label is the
  // switcher's own answer rather than a second opinion — and costs no second
  // request. The upstream field is named after the runtime, which is why this
  // goes through the neutral route instead of the SDK.
  const model = useQuery({
    queryKey: ['session-model', projectId, sessionId],
    queryFn: async () => {
      const token = getSessionToken();
      const res = await fetch(
        `/api/session-model?projectId=${encodeURIComponent(projectId)}&sessionId=${encodeURIComponent(sessionId)}`,
        { headers: token ? { Authorization: `Bearer ${token}` } : undefined },
      );
      if (!res.ok) return { model: null as string | null };
      return (await res.json()) as { model: string | null };
    },
    staleTime: 30_000,
    retry: false,
  });

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
    boundAuthorizations: liveBindings,
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
  const [typed, setTyped] = useState('');

  const nextSecrets =
    draftSecrets === undefined
      ? (authoritativeScope?.secrets_allowlist ?? null)
      : draftSecrets;
  const nextBindings = draftBindings ?? liveBindings;
  const issues = scopeDraftIssues(nextSecrets ?? [], items);

  const start = useMutation({
    mutationFn: async () => {
      const nextId = generateSessionId();
      await kortix.project(projectId).sessions.create(
        buildSessionCreateInput(
          // The agent comes along too, or "with this scope" would quietly drop
          // the one part of the scope that is already right.
          {
            agent: data?.agent_name ?? null,
            secrets: nextSecrets,
            bindings: nextBindings,
            runtimeContext: null,
          },
          { sessionId: nextId },
        ),
      );
      return nextId;
    },
    onSuccess: (nextId) => {
      invalidateSessions(qc, projectId);
      router.push(`/projects/${projectId}/sessions/${nextId}`);
    },
    onError: (err) => {
      const failure = sessionCreateFailure(err);
      toast.error(failure.title, { description: failure.detail });
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
        This session&apos;s scope could not be read just now.
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

  const toggleSecret = (identifier: string, on: boolean) => {
    const base = nextSecrets ?? [];
    setDraftSecrets(
      on
        ? [...new Set([...base, identifier])]
        : base.filter((id) => id !== identifier),
    );
  };

  const typedState = classifyTypedIdentifier(typed, {
    secrets: items,
    draft: nextSecrets ?? [],
  });

  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      <ScopeChip
        icon={<Bot className="size-3" />}
        label="Agent"
        value={data.agent_name ?? 'Project default'}
        title="Agent"
        badge={scopeControl('agent').badge}
        note={scopeControl('agent').note}
      />

      <ScopeChip
        icon={<Lock className="size-3" />}
        label="Secrets"
        // Derived from the session's own allowlist, so it stays true even when
        // the project's secret list is the thing that failed to load.
        value={live.summary}
        title="Secrets"
        badge={scopeControl('secrets').badge}
        // BOTH: what this session's allowlist actually is, and — when the
        // session is running — why the ~8 switches below cannot move it. The
        // first version passed only `live.detail`, so the popover offered a
        // wall of controls and never explained that they were frozen; the
        // frozen copy existed and was asserted by a test while being rendered
        // nowhere.
        note={
          scopeControl('secrets').live
            ? live.detail
            : `${live.detail} ${scopeControl('secrets').note}`
        }
      >
        <div className="mt-3 space-y-2">
          {/* An unread project list is not an empty one. "No secrets" here
              would be a claim about secret access that nothing established. */}
          {secrets.isError && (
            <p className="text-xs text-muted-foreground">
              This project&apos;s secrets could not be read just now, so only
              the allowlist itself is shown:{' '}
              {live.narrowed
                ? authoritativeScope.secrets_allowlist?.join(', ') || 'nothing'
                : 'it was never narrowed'}
              .
            </p>
          )}
          {!secrets.isError && live.rows.length === 0 && (
            <p className="text-xs text-muted-foreground">
              This project has no secrets a session allowlist can name.
            </p>
          )}
          {live.rows.map((row) => (
            <div
              key={row.identifier}
              className="flex items-start justify-between gap-2"
            >
              <div className="min-w-0">
                <div className="truncate font-mono text-xs">
                  {row.identifier}
                </div>
                {/* The KEY is shown next to every identifier, always: the
                    allowlist addresses the identifier, the sandbox sees the
                    KEY, and they are routinely different names. */}
                <div className="truncate font-mono text-[11px] text-muted-foreground">
                  {row.name}
                </div>
              </div>
              <Badge
                variant={row.membership === 'allowed' ? 'outline' : 'ghost'}
                className={
                  row.membership === 'excluded'
                    ? 'text-muted-foreground'
                    : undefined
                }
              >
                {SECRET_MEMBERSHIP_LABEL[row.membership]}
              </Badge>
            </div>
          ))}
          {!secrets.isError && live.missing.length > 0 && (
            <div className="rounded-md border border-border bg-muted/30 px-2.5 py-2">
              <div className="font-mono text-xs">{live.missing.join(', ')}</div>
              <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
                {MISSING_SECRET_NOTE}
              </p>
            </div>
          )}
        </div>

        <ScopeEditor
          label="Change what this session may read"
          // No draft editor without the list it edits: a change built on a list
          // that failed to load would name identifiers nobody verified.
          //
          // NOT gated on `secretsFixed` any more. It was, and when secrets became
          // changeable that flag went false and took the ONLY editing controls
          // with it — the popover said "Changeable" over a read-only list.
          show={!secrets.isError}
        >
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor="scope-bar-narrow" className="text-xs font-normal">
              Limit it to a list
            </Label>
            <Switch
              id="scope-bar-narrow"
              checked={nextSecrets !== null}
              onCheckedChange={(on) =>
                setDraftSecrets(on ? (nextSecrets ?? []) : null)
              }
            />
          </div>
          {nextSecrets === null ? (
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              Off, this session gets its agent&apos;s full secret grant — no
              narrowing at all.
            </p>
          ) : (
            <div className="space-y-2">
              {live.rows.map((row) => (
                <div
                  key={row.identifier}
                  className="flex items-center justify-between gap-3"
                >
                  <Label
                    htmlFor={`scope-bar-secret-${row.identifier}`}
                    className="min-w-0 font-mono text-xs font-normal"
                  >
                    <span className="truncate">{row.identifier}</span>
                    {row.name !== row.identifier && (
                      <span className="truncate text-muted-foreground">
                        → {row.name}
                      </span>
                    )}
                  </Label>
                  <Switch
                    id={`scope-bar-secret-${row.identifier}`}
                    checked={nextSecrets.includes(row.identifier)}
                    onCheckedChange={(on) => toggleSecret(row.identifier, on)}
                  />
                </div>
              ))}
              {nextSecrets
                .filter((id) => !live.rows.some((row) => row.identifier === id))
                .map((id) => (
                  <div
                    key={id}
                    className="flex items-center justify-between gap-3"
                  >
                    <span className="min-w-0 truncate font-mono text-xs">
                      {id}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-[11px]"
                      onClick={() => toggleSecret(id, false)}
                    >
                      Remove
                    </Button>
                  </div>
                ))}

              <div className="space-y-1.5 border-t border-border pt-2">
                <Label
                  htmlFor="scope-bar-new-identifier"
                  className="text-xs font-normal"
                >
                  Allow another identifier
                </Label>
                <div className="flex items-center gap-1.5">
                  <Input
                    id="scope-bar-new-identifier"
                    value={typed}
                    onChange={(e) => setTyped(e.target.value)}
                    placeholder="STRIPE_LIVE"
                    className="h-8 font-mono text-xs"
                  />
                  <Button
                    size="sm"
                    variant="secondary"
                    className="h-8"
                    disabled={
                      typedState.kind === 'empty' ||
                      typedState.kind === 'already_listed'
                    }
                    onClick={() => {
                      if (
                        typedState.kind === 'empty' ||
                        typedState.kind === 'already_listed'
                      ) {
                        return;
                      }
                      toggleSecret(typedState.identifier, true);
                      setTyped('');
                    }}
                  >
                    Add
                  </Button>
                </div>
                {typedState.kind === 'already_listed' && (
                  <p className="text-[11px] text-muted-foreground">
                    Already on the list.
                  </p>
                )}
                {/* Said where they type it, not after the create fails: this
                    app can list a project's secrets but cannot mint one, and
                    an allowlist naming an identifier that does not exist is
                    refused at start. */}
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  {NEW_IDENTIFIER_HINT}
                </p>
              </div>
            </div>
          )}
        </ScopeEditor>
        {/* Apply to THIS session. Shown above "start a new session" because it is
            now the ordinary path — starting fresh is the fallback for the one
            thing a re-scope cannot do, not the default. */}
        {hasScopeDraft(draftSecrets) && (
          <div className="mt-2 space-y-1.5 border-t border-border pt-2">
            <Button
              size="sm"
              className="w-full"
              disabled={applyScope.isPending || issues.length > 0}
              onClick={() => applyScope.mutate({ secrets: nextSecrets })}
            >
              {applyScope.isPending ? 'Applying…' : 'Apply to this session'}
            </Button>
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              Takes effect on the next prompt. Removing one stops it being
              handed out — it cannot un-read a value the agent already has, so
              rotate it if you need it truly revoked.
            </p>
          </div>
        )}
        {startAction}
        {/* The call behind the control, next to the control — the demo's job is
            to teach what to send, and re-scoping is the least obvious of these. */}
        <CallSnippet id="session.rescope" context={{ projectId, sessionId }} />
      </ScopeChip>

      <ScopeChip
        icon={<Plug className="size-3" />}
        label="Connections"
        value={connections.summary}
        title="Connections"
        badge={scopeControl('connections').badge}
        note={scopeControl('connections').note}
      >
        <div className="mt-3 space-y-2">
          {connections.rows.length === 0 && (
            <p className="text-xs text-muted-foreground">
              This project has no connectors connected yet.
            </p>
          )}
          {connections.rows.map((row) => (
            <div key={row.alias} className="space-y-0.5">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate font-mono text-xs text-muted-foreground">
                  {row.alias}
                </span>
                <span className="truncate text-xs">
                  {row.bound ?? 'Project default'}
                </span>
              </div>
              {/* The remedy is always a teammate. A wrapper acts under one
                  credential for many end-users, so it has no upstream identity
                  to connect WITH, and the interactive flow that would is
                  refused for it outright. */}
              {row.notice && (
                <div className="flex items-start gap-2 rounded-md border border-border bg-muted/30 px-2.5 py-2">
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                  <div className="min-w-0">
                    <div className="text-xs">{row.notice.title}</div>
                    <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
                      {row.notice.detail}
                    </p>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>

        <ScopeEditor
          label="Bind different accounts for this session"
          // Same fix as secrets: gating on `connectionsFixed` hid the picker the
          // moment bindings became changeable, so the popover offered nothing.
          show={choices.some((choice) => choice.connections.length > 0)}
        >
          <ConnectorBindingFields
            // Only the aliases with something to bind — the unavailable ones
            // are explained once, above, and a second copy of the same notice
            // reads like a second problem.
            choices={choices.filter((choice) => choice.connections.length > 0)}
            value={nextBindings}
            onChange={setDraftBindings}
          />
        </ScopeEditor>
        {/* Same control as secrets, different guarantee: a binding is resolved
            server-side on every tool call, so this one IS fully effective — the
            copy must not borrow the secrets caveat. */}
        {hasScopeDraft(draftBindings) && (
          <div className="mt-2 space-y-1.5 border-t border-border pt-2">
            <Button
              size="sm"
              className="w-full"
              disabled={applyScope.isPending}
              onClick={() => applyScope.mutate({ bindings: nextBindings })}
            >
              {applyScope.isPending ? 'Applying…' : 'Apply to this session'}
            </Button>
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              Takes effect on the next tool call — connections resolve
              server-side, so unlike secrets this change is complete. An alias
              you unbind falls back to the project default.
            </p>
          </div>
        )}
        {startAction}
        <CallSnippet id="session.rescope" context={{ projectId, sessionId }} />
      </ScopeChip>

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

/** One compact chip. Opens a popover; the chip itself never mutates anything. */
function ScopeChip({
  icon,
  label,
  value,
  title,
  badge,
  note,
  children,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  title: string;
  badge: string;
  note: string;
  children?: ReactNode;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 gap-1.5 rounded-full border border-border/70 px-2 text-[11px] font-normal text-muted-foreground"
          aria-label={`${label}: ${value}`}
        >
          {icon}
          <span className="text-muted-foreground">{label}</span>
          <span className="max-w-40 truncate text-foreground">{value}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="top"
        className="w-80 max-h-[60dvh] overflow-y-auto scrollbar-thin"
      >
        <PopoverHeader>
          <div className="flex items-center gap-2">
            <PopoverTitle>{title}</PopoverTitle>
            <Badge variant="secondary" className="text-[11px]">
              {badge}
            </Badge>
          </div>
          <PopoverDescription className="text-xs leading-relaxed">
            {note}
          </PopoverDescription>
        </PopoverHeader>
        {children}
      </PopoverContent>
    </Popover>
  );
}

function ScopeEditor({
  label,
  show = true,
  children,
}: {
  label: string;
  show?: boolean;
  children: ReactNode;
}) {
  if (!show) return null;
  return (
    <Collapsible className="mt-3 border-t border-border pt-3">
      <CollapsibleTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-full justify-between px-1 text-xs font-normal text-muted-foreground"
        >
          {label}
          <ChevronDown className="size-3.5" />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2 space-y-2.5">
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}

/** Starts a session with the draft — or says why it would be refused. */
function StartWithScope({
  issues,
  pending,
  onStart,
}: {
  issues: string[];
  pending: boolean;
  onStart: () => void;
}) {
  return (
    <div className="mt-3 space-y-1.5 border-t border-border pt-3">
      {/* A refused allowlist can never be edited afterwards, so starting a
          session that cannot boot is not a recoverable mistake. Name it here
          instead of letting the create be the first place anyone hears it. */}
      {issues.map((issue) => (
        <p key={issue} className="text-[11px] leading-relaxed text-destructive">
          {issue}
        </p>
      ))}
      <Button
        size="sm"
        variant="secondary"
        className="h-7 w-full gap-1.5"
        disabled={pending || issues.length > 0}
        onClick={onStart}
      >
        {pending ? (
          <Loading className="size-3.5" />
        ) : (
          <Plus className="size-3.5" />
        )}
        {START_NEW_SESSION_ACTION}
      </Button>
    </div>
  );
}
