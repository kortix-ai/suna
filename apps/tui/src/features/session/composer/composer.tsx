/**
 * The open session's composer: the one input, its three selection pickers,
 * the server-side prompt queue, and the tray row under it.
 *
 * It takes the whole `useSession` result as a prop (SPEC §5.3) and owns no
 * session state of its own. Every write goes back through the SDK — `send`,
 * the durable prompt inbox, `runCommand`, `cancel`, `picks`, the model store.
 * The input itself (buffer, slash menu, Esc ×3) is `prompt-input.tsx`, shared
 * with the empty-session draft.
 *
 * ── Who runs a slash command ──
 * Four built-ins act on THIS session's hook, so they run here: `/model`,
 * `/effort`, `/agent` (open a picker) and `/stop` (`session.cancel`). A
 * project runtime command runs through `session.runCommand`. Everything else
 * goes up to the app through `onCommand`, which switches on `CommandName`.
 *
 * ── How a prompt reaches the server ──
 * `useSession.send` does NOT queue: it posts straight to the runtime and is
 * refused when the runtime is not ready. The queue is the SERVER-SIDE prompt
 * inbox (`useSessionPrompts`), which is the durable, cross-client one. So: an
 * idle session with an empty inbox sends directly, and anything else
 * enqueues, which keeps SEND ORDER — a direct send would otherwise jump the
 * rows already waiting. The tray reads the count straight off the inbox.
 */

import { type SessionPromptOverrides, type SessionPromptPart, runtimeSupports } from '@kortix/sdk';
import {
  type UseSessionResult,
  mintSessionWireMessageId,
  useSessionPrompts,
} from '@kortix/sdk/react';
import type { SessionLogMessage } from '@kortix/sdk';
import type { KeyEvent } from '@opentui/core';
import { resolve } from 'node:path';
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';

import type {
  CommandContext,
  CommandName,
  MenuEntry,
  RuntimeCommand,
} from '../../../commands/registry.ts';
import { copyToClipboard } from '../../../lib/clipboard.ts';
import { theme } from '../../../theme.ts';
import { lastReplyText, transcriptMarkdown } from '../transcript-export.ts';
import { AgentPicker } from '../pickers/agent-picker.tsx';
import { EffortPicker } from '../pickers/effort-picker.tsx';
import { ModelPicker } from '../pickers/model-picker.tsx';
import { useComposerSelection } from '../pickers/use-composer-selection.ts';
import { matchesComposerBinding } from './keys.ts';
import { PromptInput, type PromptInputMetrics } from './prompt-input.tsx';

export type SessionState = UseSessionResult;

/** Rows an open picker or host panel takes above the input (an upper bound). */
export const PICKER_RESERVE_ROWS = 12;

export interface ComposerProps {
  session: SessionState;
  projectId: string;
  sessionId: string;
  focused: boolean;
  width: number;
  context: CommandContext;
  /** Every built-in this composer does not run itself, with its arguments. */
  onCommand(command: CommandName, args: string): void;
  onToast?(message: string, kind?: 'info' | 'error'): void;
  onRequestFocus?(): void;
  /** Sizing for the transcript above (`session-view.tsx`). Memoize it. */
  onMetrics?(metrics: PromptInputMetrics): void;
  /** A host panel above the input (`/sessions`, a confirm). It takes the keyboard. */
  panel?: ReactNode;
  /** Left side of the tray: where you are. */
  trayLeft?: string;
  /** Replace the draft (e.g. `/rename <title>`). */
  seed?: { text: string; seq: number } | null;
  /** The tray module: the row under the input. Default on. */
  showTray?: boolean;
  /** The thread on screen, for `/copy` and `/export`. */
  messages?: readonly SessionLogMessage[];
  /** The session's title, for the `/export` heading and file name. */
  title?: string;
  /** Test seams. Production copies with the system tool and writes with Bun. */
  copyText?: (text: string) => Promise<{ ok: boolean; error?: string }>;
  writeFile?: (path: string, text: string) => Promise<unknown>;
}

/** `kortix-fix-the-login-bug-1a2b3c4d.md`: the title, slugged, and the id. */
export function exportFileName(title: string, sessionId: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `kortix-${slug ? `${slug}-` : ''}${sessionId.slice(0, 8)}.md`;
}

type Picker = 'model' | 'effort' | 'agent' | null;

/** The built-ins this composer runs on its own session. */
const LOCAL_COMMANDS = new Set<string>(['model', 'effort', 'agent', 'stop', 'copy', 'export']);

export function Composer({
  session,
  projectId,
  sessionId,
  focused,
  width,
  context,
  onCommand,
  onToast,
  onRequestFocus,
  onMetrics,
  panel = null,
  trayLeft = '',
  seed: hostSeed = null,
  messages = [],
  title = 'Kortix session',
  showTray = true,
  copyText = copyToClipboard,
  writeFile = (path, text) => Bun.write(path, text),
}: ComposerProps) {
  const [picker, setPicker] = useState<Picker>(null);
  const [queueError, setQueueError] = useState<string | null>(null);
  const [restore, setRestore] = useState<{ text: string; seq: number } | null>(null);
  const [inputMetrics, setInputMetrics] = useState<PromptInputMetrics>({
    rows: 1,
    aboveRows: 0,
    menuOpen: false,
  });

  const inbox = useSessionPrompts(projectId, sessionId);
  const selection = useComposerSelection(session, projectId);

  const covered = picker !== null || panel !== null;

  // The host sizes the transcript from this: the input's own rows, plus a
  // fixed reserve while a picker or a host panel stands above it.
  useEffect(() => {
    onMetrics?.({
      rows: inputMetrics.rows,
      aboveRows: covered ? PICKER_RESERVE_ROWS : inputMetrics.aboveRows,
      menuOpen: !covered && inputMetrics.menuOpen,
    });
  }, [inputMetrics, covered, onMetrics]);

  const closePicker = useCallback(() => {
    setPicker(null);
    onRequestFocus?.();
  }, [onRequestFocus]);

  // ── sending ───────────────────────────────────────────────────────────────

  // A QUEUED prompt pins what was selected when it was queued: the inbox row is
  // durable and may be sent minutes later, after the pickers have moved on.
  // A prompt sent NOW carries no overrides — `sendParts` reads `picks` itself.
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
        setRestore((current) => ({ text, seq: (current?.seq ?? 0) + 1 }));
        onToast?.(`Could not queue: ${message}`, 'error');
      });
    },
    [session, inbox.prompts.length, enqueue, onToast],
  );

  const stop = useCallback(() => {
    void session.cancel();
  }, [session]);

  const runCommand = useCallback(
    (entry: MenuEntry, args: string) => {
      if (entry.source === 'runtime') {
        void session.runCommand(entry.name, args).catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          onToast?.(`/${entry.name} failed: ${message}`, 'error');
        });
        return;
      }
      if (LOCAL_COMMANDS.has(entry.name)) {
        if (entry.name === 'stop') {
          if (!session.isBusy) return void onToast?.('Nothing is running.');
          stop();
          onToast?.('Stopping…');
          return;
        }
        if (entry.name === 'copy') {
          const text = lastReplyText(messages);
          if (!text) return void onToast?.('No reply to copy yet.');
          void copyText(text).then((result) =>
            result.ok
              ? onToast?.(`Copied the last reply (${text.length} characters).`)
              : onToast?.(`Copy failed: ${result.error ?? 'no clipboard tool'}.`, 'error'),
          );
          return;
        }
        if (entry.name === 'export') {
          const path = resolve(process.cwd(), args.trim() || exportFileName(title, sessionId));
          void Promise.resolve(writeFile(path, transcriptMarkdown(messages, title)))
            .then(() => onToast?.(`Saved ${path}`))
            .catch((error: unknown) =>
              onToast?.(
                `Export failed: ${error instanceof Error ? error.message : String(error)}`,
                'error',
              ),
            );
          return;
        }
        setPicker(entry.name as Exclude<Picker, null>);
        return;
      }
      onCommand(entry.name as CommandName, args);
    },
    [session, stop, onCommand, onToast, messages, title, sessionId, copyText, writeFile],
  );

  // Alt+M / Alt+E / Alt+G open the pickers from anywhere in the input.
  const onKey = useCallback((key: KeyEvent) => {
    const opened: Picker = matchesComposerBinding(key, 'composer.model')
      ? 'model'
      : matchesComposerBinding(key, 'composer.effort')
        ? 'effort'
        : matchesComposerBinding(key, 'composer.agent')
          ? 'agent'
          : null;
    if (opened) setPicker(opened);
    return opened !== null;
  }, []);

  // ── render ────────────────────────────────────────────────────────────────

  const runtimeCommands = useMemo<readonly RuntimeCommand[]>(
    () =>
      runtimeSupports(context.capabilities, 'session.commands') ? (session.commands ?? []) : [],
    [session.commands, context.capabilities],
  );

  const queuedCount = inbox.prompts.length;
  const sendError = session.sendError;
  const errorLine = sendError
    ? `${sendError.kind}: ${sendError.message}`
    : queueError
      ? `queue: ${queueError}`
      : null;

  const status: string[] = [];
  if (queuedCount > 0) status.push(`${queuedCount} queued`);
  if (session.isSending) status.push('sending');

  const pickerWidth = Math.max(Math.min(width, 72), 24);
  const seed = restore && (!hostSeed || restore.seq > hostSeed.seq) ? restore : hostSeed;

  const tray = (
    <box
      flexDirection="row"
      justifyContent="space-between"
      height={1}
      paddingLeft={1}
      paddingRight={1}
    >
      <text fg={theme.faint} wrapMode="none">
        {trayLeft}
      </text>
      <text fg={theme.dim} wrapMode="none">
        {status.length ? <span fg={theme.busy}>{`${status.join(' · ')}  `}</span> : null}
        <span fg={selection.modelIsDefault ? theme.dim : theme.fg}>{selection.modelLabel}</span>
        {selection.variant ? <span fg={theme.dim}>{`:${selection.variantLabel}`}</span> : null}
        <span fg={theme.faint}>{' · '}</span>
        <span fg={theme.dim}>{selection.agentLabel}</span>
      </text>
    </box>
  );

  return (
    <box flexDirection="column" width={width} zIndex={1}>
      {panel}

      {picker === 'model' ? (
        <ModelPicker
          groups={selection.groups}
          models={selection.models}
          selected={session.picks.model}
          width={pickerWidth}
          onClose={closePicker}
          onUnavailable={(model) =>
            onToast?.(`${model.modelName} is turned off for this project.`, 'error')
          }
          onPick={(key) => {
            selection.setModel(key);
            closePicker();
          }}
        />
      ) : null}

      {picker === 'effort' ? (
        <EffortPicker
          variants={selection.variants}
          selected={selection.variant}
          width={pickerWidth}
          onClose={closePicker}
          onPick={(variant) => {
            selection.setVariant(variant);
            closePicker();
          }}
        />
      ) : null}

      {picker === 'agent' ? (
        <AgentPicker
          agents={selection.agents}
          selected={selection.agent}
          width={pickerWidth}
          onClose={closePicker}
          onPick={(name) => {
            selection.setAgent(name);
            closePicker();
          }}
        />
      ) : null}

      {errorLine ? (
        <text fg={theme.danger} wrapMode="none">
          {errorLine}
        </text>
      ) : null}

      <PromptInput
        focused={focused && !covered}
        width={width}
        placeholder={
          session.isBusy
            ? 'Type to queue the next prompt · / for commands'
            : 'Type a prompt · / for commands'
        }
        context={context}
        runtimeCommands={runtimeCommands}
        busy={session.isBusy}
        onSubmit={sendText}
        onCommand={runCommand}
        onStop={stop}
        onToast={onToast}
        onKey={onKey}
        onMetrics={setInputMetrics}
        seed={seed}
        footer={showTray ? tray : null}
      />
    </box>
  );
}
