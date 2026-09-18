'use client';

import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';

import { errorToast } from '@/components/ui/toast';
import { SessionOverridesComposer } from '@/features/session/overrides/session-overrides-composer';
import type { SessionOverrideSlot } from '@/features/session/overrides/session-overrides-toolbar';
import type { SessionScopeCommit } from '@/features/session/scope/session-scope-model';
import {
  type AttachedFile,
  SessionChatInput,
  type SessionChatInputProps,
} from '@/features/session/session-chat-input';
import type { SessionPromptOverrides } from '@kortix/sdk';
import type { AttachmentSubmission } from './composer/attachment-submission';
import { type Command, useFeatureFlag, type ModelKey, useProjectConfig, useRuntimeAgents, useRuntimeCommands, useRuntimeConfig, useRuntimeProviders, useSessionModelSelection, useSessionProviderSecretPools } from '@kortix/sdk/react';
import { isMetaAgentName } from '@kortix/shared';
import { resolveComposerAgent } from './composer/composer-agent-access';
import type { DraftScope } from './composer/draft/composer-draft';

export interface ComposerOptions {
  placement?: 'transcript' | 'composer';
  agent?: string;
  model?: ModelKey;
  variant?: string;
  scope?: SessionScopeCommit;
  providerSecretPools?: Record<string, string[]>;
}

/**
 * The canonical "compose a first message" input: {@link SessionChatInput}
 * pre-wired with the OpenCode model / agent / variant / command selectors (the
 * four catalog queries + per-session selection state). Used by the home composer
 * and the instant session shell so neither hand-rolls the selector wiring.
 *
 * The current selections are handed to `onSend` / `onCommand` as `options`, so
 * callers never need their own `useRuntimeLocal`.
 */
export function ComposerChatInput({
  onSend,
  onCommand,
  sessionId,
  projectId,
  isBusy,
  sessionWorking,
  runtimeReady,
  stopDisabled,
  isSending,
  disabled,
  autoFocus,
  placeholder,
  prefill,
  onPrefillApplied,
  inputSlot,
  toolbarSlot,
  underbarPlacement,
  slashMenuPlacement,
  cardClassName,
  parentClassName,
  boundAgentName,
  clearOnSend,
  onAgentSelectionChange,
  sandboxSlot,
  draftScope,
  draftActive,
  promptAttachments,
}: {
  onSend: (
    text: string,
    files: AttachedFile[] | undefined,
    options: ComposerOptions,
    attachments?: AttachmentSubmission,
  ) => void | Promise<void>;
  onCommand?: (command: Command, args: string | undefined, options: ComposerOptions) => void;
  sessionId?: string;
  projectId?: string;
  isBusy?: boolean;
  /** Server turn authority, distinct from the busy fade. See the composer. */
  sessionWorking?: boolean;
  /** The sandbox is up and switched. Gates `/` COMMANDS only — see the
   *  composer. */
  runtimeReady?: boolean;
  /** Show a disabled stop button while busy (e.g. the computer is still booting). */
  stopDisabled?: boolean;
  /** Send in flight, not yet settled — spinner in the send slot (see SessionChatInput.isSending). */
  isSending?: boolean;
  disabled?: boolean;
  /** Clear the composer optimistically on send. Set false on the project-home
   *  composer, whose send navigates it away (see SessionChatInput.clearOnSend). */
  clearOnSend?: boolean;
  autoFocus?: boolean;
  placeholder?: string;
  prefill?: {
    text: string;
    id: number;
    files?: AttachedFile[];
    mode?: 'replace' | 'merge';
    options?: SessionPromptOverrides | null;
  } | null;
  onPrefillApplied?: SessionChatInputProps['onPrefillApplied'];
  inputSlot?: ReactNode;
  toolbarSlot?: ReactNode;
  underbarPlacement?: SessionChatInputProps['underbarPlacement'];
  slashMenuPlacement?: SessionChatInputProps['slashMenuPlacement'];
  /** Extra classes for the input card (e.g. the project-home radius override). */
  cardClassName?: string;
  /** Extra classes for the composer shell. */
  parentClassName?: string;
  /** Immutable project-session agent. When set, sends are locked to this agent. */
  boundAgentName?: string | null;
  /** Reports the effective agent to parent controls such as the sandbox picker. */
  onAgentSelectionChange?: (agentName: string | null) => void;
  /** Pre-create sandbox-template chooser, rendered inside the overrides panel. */
  sandboxSlot?: SessionOverrideSlot;
  /** Persist the unsent draft under this scope — see `composer/draft/`. */
  draftScope?: DraftScope | null;
  draftActive?: boolean;
  /** Host-owned upload controller. See `SessionChatInputProps.promptAttachments`. */
  promptAttachments?: SessionChatInputProps['promptAttachments'];
}) {
  const { data: agents } = useRuntimeAgents({ projectId });
  const { data: providers, isLoading: providersLoading } = useRuntimeProviders();
  const { data: commands } = useRuntimeCommands();
  const { data: config } = useRuntimeConfig();
  const projectConfig = useProjectConfig(projectId);
  const local = useSessionModelSelection({
    agents,
    providers,
    config,
    sessionId,
    boundAgentName,
    defaultAgentName: projectConfig?.open_code_default_agent,
  });
  const restoredOptions = prefill?.options;
  const setAgent = local.agent.set;
  const setModel = local.model.set;
  const setVariant = local.model.variant.set;
  useEffect(() => {
    if (!restoredOptions) return;
    if (restoredOptions.agent) setAgent(restoredOptions.agent);
    if (restoredOptions.model) setModel(restoredOptions.model);
    setVariant(restoredOptions.variant ?? undefined);
  }, [restoredOptions, setAgent, setModel, setVariant]);

  // The meta agent is the only thing that pins the picker: a meta session must
  // keep running its own agent. Every other session is freely switchable.
  const lockedAgentName = isMetaAgentName(boundAgentName) ? boundAgentName?.trim() || null : null;
  /**
   * What will ACTUALLY run — see `composer-agent-access.ts`.
   *
   * `local.agent.current` resolves over the SDK's visible roster (subagents
   * included) and returns `undefined` on an empty one, which is how the picker
   * ended up rendering nothing while the send still went out under the
   * server's manifest default. This narrows it to the agents the picker can
   * actually offer, and the same name is what `options()` sends.
   *
   * `agents === undefined` is the roster still loading; the resolver refuses
   * nothing until it lands.
   */
  const agentResolution = resolveComposerAgent({
    agents,
    boundAgent: boundAgentName,
    defaultAgent: projectConfig?.open_code_default_agent,
    selectedAgent: local.agent.current?.name ?? null,
  });
  const selectedAgentName = lockedAgentName ?? agentResolution.selected;
  // A locked meta session runs its own bound agent, so an empty project roster
  // does not refuse it.
  const noAccessibleAgents = !lockedAgentName && agentResolution.disabled;

  useEffect(() => {
    onAgentSelectionChange?.(selectedAgentName);
  }, [onAgentSelectionChange, selectedAgentName]);

  const [newSessionScope, setNewSessionScope] = useState<{
    agentName: string | null;
    commit: SessionScopeCommit;
  } | null>(null);
  const [newProviderSecretPools, setNewProviderSecretPools] = useState<Record<string, string[]>>({});

  // Flag-gated for the same reason the picker's own read is: every pool route
  // answers 403 without `pooled_provider_secrets`, and the SDK toasts a 403.
  // Ungated, every session page load would put "Forbidden" in front of every
  // user on every project that does not have the flag. `useFeatureFlag` reads
  // the project detail query, so this costs no extra request.
  const pooledSecretsEnabled = useFeatureFlag(projectId, 'pooled_provider_secrets').enabled;
  const sessionPools = useSessionProviderSecretPools(
    pooledSecretsEnabled ? projectId : null,
    sessionId,
  );

  /*
    The picker both READS and WRITES which credential a provider bills to.

    Session overrides -> Provider keys is not a substitute: it edits a POOL
    with checkboxes ("these keys are allowed"), which cannot say "use THIS
    one". The picker's question is singular, so it writes a single-element
    pool.

    Two destinations, one control. A live session writes through its own pool
    endpoint and takes effect on the next prompt. A session that does not
    exist yet has nowhere to write, so the choice is held as the draft that
    rides `provider_secret_pools` in the create body.
  */
  const handleSelectProviderAccount = useCallback(
    (providerID: string, secretId: string | null) => {
      const secretIds = secretId ? [secretId] : null;
      if (sessionId) {
        // The route can still refuse — a non-owner, a session whose model is
        // locked, the gateway turned off. Say so: the picker's check would
        // otherwise settle back on the old account with no explanation.
        sessionPools.setPool.mutate(
          { providerId: providerID, secretIds },
          { onError: (error: unknown) => errorToast(error instanceof Error ? error.message : String(error)) },
        );
        return;
      }
      setNewProviderSecretPools((prev) => {
        const next = { ...prev };
        if (secretIds) next[providerID] = secretIds;
        else delete next[providerID];
        return next;
      });
    },
    [sessionId, sessionPools.setPool],
  );
  /*
    `can_edit` comes from the pools endpoint itself, so the control appears
    only where the write would be accepted: the session owner or a project
    manager, a session that is not machine-owned, and the gateway enabled. A
    session that does not exist yet has no server answer and no server write —
    its choice rides the create body, so it is always editable.

    Undefined (still loading, or the feature flag refused the read) means the
    chooser stays hidden. A control that 403s on click is worse than no
    control.
  */
  const canPinProviderAccount = sessionId ? sessionPools.data?.can_edit === true : true;

  const providerAccountSelection = useMemo<Record<string, string | null>>(() => {
    const source = sessionId
      ? Object.fromEntries(
          (sessionPools.data?.pools ?? []).map((pool: { provider_id: string; secret_ids: string[] }) => [
            pool.provider_id,
            pool.secret_ids[0] ?? null,
          ]),
        )
      : newProviderSecretPools;
    return Object.fromEntries(
      Object.entries(source).map(([provider, value]) => [
        provider,
        Array.isArray(value) ? (value[0] ?? null) : ((value as string | null) ?? null),
      ]),
    );
  }, [sessionId, sessionPools.data, newProviderSecretPools]);

  const handleCommittedScope = useCallback(
    (commit: SessionScopeCommit | undefined) => {
      setNewSessionScope(commit ? { agentName: selectedAgentName, commit } : null);
    },
    [selectedAgentName],
  );
  // The axes a session can override that have no control of their own —
  // secrets, connectors, sandbox. Agent, model and effort are NOT passed: this
  // toolbar already renders each of them, and a second live control one click
  // away is a duplicate, not a convenience. See SessionOverridesComposer.
  const sessionScopeToolbar = useMemo(
    () =>
      projectId ? (
        <SessionOverridesComposer
          projectId={projectId}
          sessionId={sessionId}
          onCommittedDraft={sessionId ? undefined : handleCommittedScope}
          providerSecretPools={newProviderSecretPools}
          onProviderSecretPoolsChange={setNewProviderSecretPools}
          selectedAgent={selectedAgentName}
          sandboxSlot={sandboxSlot}
        />
      ) : null,
    [handleCommittedScope, newProviderSecretPools, projectId, sandboxSlot, selectedAgentName, sessionId],
  );

  const combinedToolbarSlot = useMemo(
    () =>
      toolbarSlot || sessionScopeToolbar ? (
        <>
          {toolbarSlot}
          {sessionScopeToolbar}
        </>
      ) : undefined,
    [sessionScopeToolbar, toolbarSlot],
  );

  // Read at send-time so the latest selections are captured.
  const options = (): ComposerOptions => {
    const o: ComposerOptions = {};
    // The resolved name, never `local.agent.current`: the composer must send
    // the agent it is SHOWING, and an inaccessible default resolves to the
    // first agent this user actually holds a grant on.
    if (selectedAgentName) o.agent = selectedAgentName;
    if (local.model.currentKey) o.model = local.model.currentKey;
    if (local.model.variant.current) o.variant = local.model.variant.current;
    if (!sessionId && newSessionScope && newSessionScope.agentName === selectedAgentName) {
      o.scope = newSessionScope.commit;
    }
    if (!sessionId && Object.keys(newProviderSecretPools).length > 0) o.providerSecretPools = newProviderSecretPools;
    return o;
  };

  return (
    <SessionChatInput
      providerAccountSelection={providerAccountSelection}
      onSelectProviderAccount={canPinProviderAccount ? handleSelectProviderAccount : undefined}
      onSend={(text, files, _mentions, attachments, placement) =>
        onSend(text, files, { ...options(), placement }, attachments)
      }
      promptAttachments={promptAttachments}
      onCommand={onCommand ? (cmd, args) => onCommand(cmd, args, options()) : undefined}
      clearOnSend={clearOnSend}
      isBusy={isBusy}
      sessionWorking={sessionWorking}
      runtimeReady={runtimeReady}
      stopDisabled={stopDisabled}
      isSending={isSending}
      disabled={disabled}
      autoFocus={autoFocus}
      placeholder={placeholder}
      prefill={prefill}
      onPrefillApplied={onPrefillApplied}
      inputSlot={inputSlot}
      toolbarSlot={combinedToolbarSlot}
      underbarPlacement={underbarPlacement}
      slashMenuPlacement={slashMenuPlacement}
      cardClassName={cardClassName}
      parentClassName={parentClassName}
      sessionId={sessionId}
      projectId={projectId}
      providers={providers}
      agents={local.agent.list}
      selectedAgent={selectedAgentName}
      noAccessibleAgents={noAccessibleAgents}
      onAgentChange={
        // The selectedAgentName effect above notifies the parent; no inline call.
        lockedAgentName ? undefined : (name) => local.agent.set(name ?? undefined)
      }
      agentSelectorLocked={!!lockedAgentName}
      models={local.model.list}
      selectedModel={local.model.currentKey ?? null}
      onModelChange={(m) => local.model.set(m ?? undefined, { recent: true })}
      modelRequired
      modelsLoading={providersLoading}
      variants={local.model.variant.list}
      selectedVariant={local.model.variant.current ?? null}
      onVariantChange={(v) => local.model.variant.set(v ?? undefined)}
      commands={commands || []}
      draftScope={draftScope}
      draftActive={draftActive}
    />
  );
}
