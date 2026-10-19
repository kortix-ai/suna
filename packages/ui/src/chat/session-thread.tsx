'use client';

/**
 * The whole chat for one session, from one `useSession` result:
 *
 *   <SessionThread session={useSession(projectId, sessionId)} />
 *
 * It renders the transcript (`MessageList`), the runtime state, the typed
 * send error, and the composer with slash commands and the model and agent
 * pickers. Everything reads off `session`: no second chat hook, no transport.
 * Slots replace one region each; the parent sets the height (the thread fills it).
 */

import { ArrowsClockwiseIcon, WarningCircleIcon, WarningIcon } from '@phosphor-icons/react';
import type { FlatModel, UseSessionResult } from '@kortix/sdk/react';
import type { ReactNode } from 'react';

import { Button } from '../components/ui/button';
import { InfoBanner } from '../components/ui/info-banner';
import { cn } from '../lib/utils';
import { useUiStrings } from '../providers/ui-provider';
import { AgentPicker } from './agent-picker';
import { Composer } from './composer';
import { MessageList } from './message-list';
import type { MessageRenderers, RenderTool } from './message-view';
import { ModelPicker } from './model-picker';
import type { ChatErrorHandler } from './permission-prompt';
import { sendFailureTitle } from './send-failure';

export type SessionThreadProps = {
  session: UseSessionResult;
  /** Replaces the composer's control row (default: model and agent pickers). */
  composerToolbar?: ReactNode;
  /** Rendered under the composer card, e.g. the session's scope. */
  composerFooter?: ReactNode;
  /** Shown when the thread has no messages. */
  emptyState?: ReactNode;
  /** Replaces the card of one tool call; return `undefined` to keep the default. */
  renderTool?: RenderTool;
  /** Overrides the renderer of any message part kind. */
  renderers?: MessageRenderers;
  /** Reports a failed permission reply, question reply or slash command (for a toast). Without it the error shows inline. */
  onError?: ChatErrorHandler;
  /** The provider line of a model row in the default model picker (a white-label relabels `kortix`). */
  providerLabel?: (model: FlatModel) => string;
  className?: string;
};

/** The default control row: the session's model and agent pickers. */
export function SessionPickers({
  session: c,
  providerLabel,
}: {
  session: UseSessionResult;
  providerLabel?: (model: FlatModel) => string;
}) {
  return (
    <div className="flex min-w-0 items-center gap-0.5">
      <ModelPicker models={c.models} value={c.picks.model} onChange={c.picks.setModel} providerLabel={providerLabel} />
      <AgentPicker agents={c.agents} value={c.picks.agent} onChange={c.picks.setAgent} defaultName={c.defaultAgent} />
    </div>
  );
}

function RuntimeState({ session: c }: { session: UseSessionResult }) {
  const t = useUiStrings().chat;
  // "Down" = it was connected and is now unreachable: a drop, not the first boot.
  if (c.switched && c.runtimePhase === 'unreachable') {
    return (
      <InfoBanner
        tone="warning"
        icon={WarningIcon}
        title={t.runtimeStopped}
        className="mb-2"
        action={
          <Button size="xs" variant="secondary" onClick={() => c.retry()}>
            <ArrowsClockwiseIcon className="size-3.5" />
            {t.reconnect}
          </Button>
        }
      />
    );
  }
  if (c.runtimePhase !== 'ready') {
    return <p className="text-muted-foreground mb-2 text-center text-xs">{t.connectingRuntime}</p>;
  }
  return null;
}

export function SessionThread({
  session: c,
  composerToolbar,
  composerFooter,
  emptyState,
  renderTool,
  renderers,
  onError,
  providerLabel,
  className,
}: SessionThreadProps) {
  const strings = useUiStrings();
  const t = strings.chat;
  const runtimeReady = c.runtimePhase === 'ready';
  // Advertise "/" only when it opens something: with no commands a "/" is sent as text.
  const placeholder = runtimeReady
    ? `${t.placeholder}${c.commands.length > 0 ? t.placeholderCommandsHint : ''}`
    : t.placeholderWaiting;

  return (
    <div data-slot="session-thread" className={cn('flex h-full min-h-0 flex-col', className)}>
      <MessageList
        session={c}
        emptyState={emptyState}
        renderTool={renderTool}
        renderers={renderers}
        onError={onError}
      />
      <div className="shrink-0 px-5 pb-5">
        <div className="mx-auto max-w-3xl">
          <RuntimeState session={c} />
          {/* A rejected send is never silent: say what failed and why. */}
          {c.sendError ? (
            <InfoBanner
              tone="destructive"
              icon={WarningCircleIcon}
              title={sendFailureTitle(c.sendError, t)}
              className="mb-2"
              role="alert"
            >
              {c.sendError.message}
            </InfoBanner>
          ) : null}
          <Composer
            onSend={c.send}
            onStop={c.cancel}
            busy={c.isBusy}
            canStop={c.canStop}
            disabled={!runtimeReady}
            placeholder={placeholder}
            commands={c.commands}
            onCommand={c.runCommand}
            onError={onError}
            toolbar={composerToolbar ?? <SessionPickers session={c} providerLabel={providerLabel} />}
            footer={composerFooter}
          />
        </div>
      </div>
    </div>
  );
}
