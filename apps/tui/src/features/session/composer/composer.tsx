/**
 * The composer: the textarea, the command palette, the three selection
 * toggles, and the one path a prompt takes to the server.
 *
 * It takes the whole `useSession` result as a prop (SPEC §5.3) and owns no
 * session state of its own. Every write goes back through the SDK — `send`,
 * the durable prompt inbox, `runCommand`, `cancel`, `picks`, the model store.
 *
 * ── Keys (see `keys.ts` for the table and the terminal facts behind it) ──
 *  Enter        send, or queue while the agent is working
 *  Ctrl+J       newline (portable). Shift+Enter under the kitty protocol.
 *  Alt+Enter    newline (raw terminals ESC-prefix it: `meta`, not `option`)
 *  Esc          clear the draft; empty + busy → arm, again within 1.5s → stop
 *  /            at column 0, open the command palette
 *  Alt+M/E/G    model / effort / agent picker
 *
 * ── How a prompt reaches the server ──
 * `useSession.send` does NOT queue: it posts straight to the runtime and is
 * refused when the runtime is not ready. The queue is the SERVER-SIDE prompt
 * inbox (`useSessionPrompts`), which is the durable, cross-client one — the
 * browser-store queue in `@kortix/sdk/message-queue` is deprecated and unused.
 * So: an idle session with an empty inbox sends directly (the path wave 0
 * proved end to end), and anything else enqueues, which keeps SEND ORDER — a
 * direct send would otherwise jump the rows already waiting. The footer reads
 * the count straight off the inbox; there is no local queue here.
 */

import type { SessionPromptOverrides, SessionPromptPart } from '@kortix/sdk';
import {
  type UseSessionResult,
  mintSessionWireMessageId,
  useSessionPrompts,
} from '@kortix/sdk/react';
import type { KeyEvent, TextareaRenderable } from '@opentui/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  composerRows,
  isSlashTrigger,
  parseMentions,
  splitCommandInput,
} from '../../../lib/composer-text.ts';
import { theme } from '../../../theme.ts';
import { AgentPicker } from '../pickers/agent-picker.tsx';
import { EffortPicker } from '../pickers/effort-picker.tsx';
import { InlinePicker } from '../pickers/inline-picker.tsx';
import { ModelPicker } from '../pickers/model-picker.tsx';
import { useComposerSelection } from '../pickers/use-composer-selection.ts';
import { isLinefeedNewline, matchesComposerBinding } from './keys.ts';
import {
  type AppCommandId,
  BUILTIN_COMMANDS,
  commandItems,
  resolveCommandItem,
} from './slash-commands.ts';

export type SessionState = UseSessionResult;

export interface ComposerProps {
  session: SessionState;
  projectId: string;
  sessionId: string;
  focused: boolean;
  width: number;
  /** Built-ins the app handles: navigation, overlays, attach, stop. */
  onCommand(command: 'new' | 'terminal' | 'files' | 'help' | 'quit' | 'attach' | 'stop'): void;
  onToast?(message: string, kind?: 'info' | 'error'): void;
  onRequestFocus?(): void;
  /**
   * How many rows the composer needs right now, so the host can size the
   * transcript above it (wave 3: `features/session/session-view.tsx`). Called
   * on mount and whenever the count changes; the host must memoize it.
   */
  onMetrics?(metrics: { rows: number; overlayOpen: boolean }): void;
}

type Overlay = 'commands' | 'model' | 'effort' | 'agent' | null;

/** How long the armed Esc stays armed before it forgets (SPEC §5.3). */
export const ESC_STOP_WINDOW_MS = 1500;

export function Composer({
  session,
  projectId,
  sessionId,
  focused,
  width,
  onCommand,
  onToast,
  onRequestFocus,
  onMetrics,
}: ComposerProps) {
  const textareaRef = useRef<TextareaRenderable>(null);
  const [draft, setDraft] = useState('');
  const draftRef = useRef('');
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [stopArmed, setStopArmed] = useState(false);
  const [queueError, setQueueError] = useState<string | null>(null);

  const inbox = useSessionPrompts(projectId, sessionId);
  const selection = useComposerSelection(session, projectId);

  // Columns the text itself gets: the panel border (2) and its padding (2).
  const textWidth = Math.max(width - 4, 10);
  const rows = composerRows(draft, textWidth);
  const mentions = useMemo(() => parseMentions(draft), [draft]);

  const setText = useCallback((value: string) => {
    draftRef.current = value;
    setDraft(value);
    const renderable = textareaRef.current;
    if (renderable && renderable.plainText !== value) renderable.setText(value);
  }, []);

  // The armed Esc forgets itself. Without the timer a stray Esc from minutes
  // ago would turn the next one into a stop.
  useEffect(() => {
    if (!stopArmed) return;
    const timer = setTimeout(() => setStopArmed(false), ESC_STOP_WINDOW_MS);
    return () => clearTimeout(timer);
  }, [stopArmed]);

  // The host sizes the transcript from this. `rows` is the textarea's own row
  // count; `overlayOpen` tells the host to reserve room for the palette that
  // grows upward out of the input.
  useEffect(() => {
    onMetrics?.({ rows, overlayOpen: overlay !== null });
  }, [rows, overlay, onMetrics]);

  const closeOverlay = useCallback(() => {
    setOverlay(null);
    onRequestFocus?.();
  }, [onRequestFocus]);

  // ── sending ───────────────────────────────────────────────────────────────

  // A QUEUED prompt pins what was selected when it was queued: the inbox row is
  // durable and may be sent minutes later, after the pickers have moved on.
  // A prompt sent NOW carries no overrides — `sendParts` reads `picks` itself
  // (model, agent and, since `SessionPicks` gained it, variant), so repeating
  // them here would be a second copy of the same three values.
  const overrides = useCallback((): SessionPromptOverrides => {
    const picked = session.picks.model;
    return {
      ...(session.picks.agent ? { agent: session.picks.agent } : {}),
      ...(picked ? { model: { providerID: picked.providerID, modelID: picked.modelID } } : {}),
      ...(selection.variant ? { variant: selection.variant } : {}),
    };
  }, [session.picks.model, session.picks.agent, selection.variant]);

  const enqueue = useCallback(
    async (text: string) => {
      const clientMessageId =
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `tui_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
      const parts: SessionPromptPart[] = [{ type: 'text', text }];
      await inbox.enqueue({
        clientMessageId,
        messageId: mintSessionWireMessageId(sessionId, clientMessageId),
        parts,
        placement: 'composer',
        clientSentAtMs: Date.now(),
        overrides: overrides(),
      });
    },
    [inbox, sessionId, overrides],
  );

  const sendText = useCallback(
    (text: string) => {
      setQueueError(null);
      const queued = session.isBusy || inbox.prompts.length > 0;
      if (!queued) {
        session.send(text);
        return;
      }
      void enqueue(text).catch((error: unknown) => {
        // The row never became durable, so the draft is the only copy left.
        // Put it back rather than losing what the user typed.
        const message = error instanceof Error ? error.message : String(error);
        setQueueError(message);
        setText(text);
        onToast?.(`Could not queue: ${message}`, 'error');
      });
    },
    [session, inbox.prompts.length, enqueue, onToast, setText],
  );

  const runAppCommand = useCallback(
    (id: AppCommandId) => {
      if (id === 'stop') {
        void session.cancel();
        onCommand('stop');
        return;
      }
      onCommand(id);
    },
    [session, onCommand],
  );

  const runRuntimeCommand = useCallback(
    (name: string, args: string) => {
      void session.runCommand(name, args).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        onToast?.(`/${name} failed: ${message}`, 'error');
      });
    },
    [session, onToast],
  );

  /**
   * Submit whatever is in the buffer.
   *
   * A draft that STARTS with a slash is routed as a command even though the
   * palette normally intercepts `/` before it reaches the buffer — a paste, or
   * a `/` typed after the palette was dismissed, must not be sent to the model
   * as literal text when it names a real command.
   */
  const submit = useCallback(() => {
    const text = draftRef.current.trim();
    if (!text) return;
    const typed = splitCommandInput(text);
    if (typed) {
      const builtin = BUILTIN_COMMANDS.find((entry) => entry.name === typed.name);
      const runtime = (session.commands ?? []).find((entry) => entry.name === typed.name);
      if (builtin || runtime) {
        setText('');
        if (builtin?.target === 'picker') {
          setOverlay(builtin.name as Exclude<Overlay, 'commands' | null>);
          return;
        }
        if (builtin) return runAppCommand(builtin.name as AppCommandId);
        return runRuntimeCommand(typed.name, typed.args);
      }
    }
    setText('');
    sendText(text);
  }, [session.commands, setText, sendText, runAppCommand, runRuntimeCommand]);

  // ── keys ──────────────────────────────────────────────────────────────────

  /**
   * Every composer key arrives here.
   *
   * `onKeyDown` is the renderable-scoped hook: OpenTUI runs it only while the
   * textarea is focused, and runs it BEFORE the textarea's own editing action,
   * so `preventDefault()` is what stops Enter from inserting a newline
   * (`docs/opentui-api-reference.md` §2.4). A global `useKeyboard` handler
   * would have to re-derive focus and could not suppress the built-in.
   */
  const onKeyDown = useCallback(
    (key: KeyEvent) => {
      // Ctrl+J reaches us as the linefeed byte, which the textarea's own
      // default binding already turns into a newline. Stand down.
      if (isLinefeedNewline(key)) return;

      if (matchesComposerBinding(key, 'composer.cancel')) {
        key.preventDefault();
        if (draftRef.current.length > 0) {
          setText('');
          setStopArmed(false);
          return;
        }
        if (!session.isBusy) return;
        if (stopArmed) {
          setStopArmed(false);
          void session.cancel();
          onCommand('stop');
          onToast?.('Stopping…');
          return;
        }
        setStopArmed(true);
        onToast?.('Esc again to stop');
        return;
      }

      if (matchesComposerBinding(key, 'composer.newline')) {
        key.preventDefault();
        const renderable = textareaRef.current;
        if (!renderable) return;
        const offset = renderable.cursorOffset;
        const text = renderable.plainText;
        renderable.replaceText(`${text.slice(0, offset)}\n${text.slice(offset)}`);
        renderable.cursorOffset = offset + 1;
        draftRef.current = renderable.plainText;
        setDraft(renderable.plainText);
        return;
      }

      if (matchesComposerBinding(key, 'composer.send')) {
        key.preventDefault();
        submit();
        return;
      }

      if (matchesComposerBinding(key, 'composer.commands')) {
        const renderable = textareaRef.current;
        const offset = renderable?.cursorOffset ?? draftRef.current.length;
        if (isSlashTrigger(renderable?.plainText ?? draftRef.current, offset)) {
          // Swallow the slash: the palette IS the input from here, and a
          // leftover `/` in the buffer would be sent with the next prompt.
          key.preventDefault();
          setOverlay('commands');
        }
        return;
      }

      if (matchesComposerBinding(key, 'composer.model')) {
        key.preventDefault();
        setOverlay('model');
        return;
      }
      if (matchesComposerBinding(key, 'composer.effort')) {
        key.preventDefault();
        setOverlay('effort');
        return;
      }
      if (matchesComposerBinding(key, 'composer.agent')) {
        key.preventDefault();
        setOverlay('agent');
        return;
      }

      if (stopArmed) setStopArmed(false);
    },
    [session, submit, setText, stopArmed, onCommand, onToast],
  );

  // ── render ────────────────────────────────────────────────────────────────

  const queuedCount = inbox.prompts.length;
  const sendError = session.sendError;
  const errorLine = sendError
    ? `${sendError.kind}: ${sendError.message}`
    : queueError
      ? `queue: ${queueError}`
      : null;

  const status: string[] = [];
  if (queuedCount > 0) status.push(`queued ${queuedCount}`);
  if (session.isSending) status.push('sending');
  if (mentions.length > 0) status.push(`@${mentions.length}`);
  if (stopArmed) status.push('Esc again to stop');
  status.push(session.isBusy ? 'Enter queues' : 'Enter sends');

  const pickerWidth = Math.max(Math.min(width, 72), 24);

  return (
    <box flexDirection="column" width={width}>
      {overlay === 'commands' ? (
        <InlinePicker
          title="Commands"
          items={commandItems(session.commands)}
          width={pickerWidth}
          onClose={closeOverlay}
          onPick={(item) => {
            const action = resolveCommandItem(item.id);
            if (!action) return;
            if (action.kind === 'picker') {
              setOverlay(action.id);
              return;
            }
            closeOverlay();
            if (action.kind === 'app') runAppCommand(action.id);
            else runRuntimeCommand(action.name, '');
          }}
        />
      ) : null}

      {overlay === 'model' ? (
        <ModelPicker
          groups={selection.groups}
          models={selection.models}
          selected={session.picks.model}
          width={pickerWidth}
          onClose={closeOverlay}
          onUnavailable={(model) =>
            onToast?.(`${model.modelName} is turned off for this project.`, 'error')
          }
          onPick={(key) => {
            selection.setModel(key);
            closeOverlay();
          }}
        />
      ) : null}

      {overlay === 'effort' ? (
        <EffortPicker
          variants={selection.variants}
          selected={selection.variant}
          width={pickerWidth}
          onClose={closeOverlay}
          onPick={(variant) => {
            selection.setVariant(variant);
            closeOverlay();
          }}
        />
      ) : null}

      {overlay === 'agent' ? (
        <AgentPicker
          agents={selection.agents}
          selected={selection.agent}
          width={pickerWidth}
          onClose={closeOverlay}
          onPick={(name) => {
            selection.setAgent(name);
            closeOverlay();
          }}
        />
      ) : null}

      {errorLine ? (
        <text fg={theme.danger} wrapMode="none">
          {errorLine}
        </text>
      ) : null}

      <box
        border
        borderStyle="single"
        borderColor={focused && !overlay ? theme.borderFocus : theme.border}
        backgroundColor={theme.bg}
        paddingLeft={1}
        paddingRight={1}
        flexDirection="column"
        overflow="hidden"
      >
        <textarea
          ref={textareaRef}
          focused={focused && overlay === null}
          height={rows}
          wrapMode="word"
          placeholder="Type / for skills, commands, and files"
          placeholderColor={theme.faint}
          textColor={theme.fg}
          focusedTextColor={theme.fg}
          backgroundColor={theme.bg}
          focusedBackgroundColor={theme.bg}
          cursorColor={theme.accent}
          onKeyDown={onKeyDown}
          onContentChange={() => {
            const value = textareaRef.current?.plainText ?? '';
            draftRef.current = value;
            setDraft(value);
          }}
        />
      </box>

      <box flexDirection="row" justifyContent="space-between" height={1}>
        <text fg={theme.dim} wrapMode="none">
          <span fg={selection.modelIsDefault ? theme.dim : theme.fg}>{selection.modelLabel}</span>
          <span fg={theme.faint}>{' ▾  '}</span>
          <span fg={selection.variant ? theme.fg : theme.dim}>{selection.variantLabel}</span>
          <span fg={theme.faint}>{' ▾  '}</span>
          <span fg={theme.fg}>{selection.agentLabel}</span>
          <span fg={theme.faint}>{' ▾'}</span>
        </text>
        <text fg={theme.faint} wrapMode="none">
          {status.join(' · ')}
        </text>
      </box>
    </box>
  );
}
