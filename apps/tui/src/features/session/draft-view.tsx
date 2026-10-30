/**
 * The screen with no session open: the splash and the one input.
 *
 * The TUI is session-first, so this is not an empty state to leave — it is a
 * new session that does not exist yet. The first prompt creates it with that
 * prompt as its first message (`createSession(projectId, { initial_prompt })`:
 * the server sends the reply, so nothing races the runtime boot), then the app
 * opens it. Every `/` command works here too; the ones that need a session
 * are listed dimmed with the reason.
 *
 * It calls no session hook: there is no session. That is why it renders
 * `PromptInput` directly and not `Composer`.
 */

import { type ReactNode, useCallback, useState } from 'react';

import type { CommandContext, CommandName, MenuEntry } from '../../commands/registry.ts';
import { theme } from '../../theme.ts';
import { Panel, Splash, type SplashLine, Spinner } from '../../ui/index.ts';
import { PICKER_RESERVE_ROWS } from './composer/composer.tsx';
import { PromptInput, type PromptInputMetrics } from './composer/prompt-input.tsx';

export interface DraftViewProps {
  width: number;
  height: number;
  focused: boolean;
  borderless: boolean;
  context: CommandContext;
  /** Splash metadata: host, account, project. */
  splashLines: readonly SplashLine[];
  /** Left side of the tray. */
  trayLeft: string;
  /** Create the session with this first prompt. Resolves when it is open. */
  onStart(prompt: string): Promise<void>;
  onCommand(command: CommandName, args: string): void;
  onToast(message: string, kind?: 'info' | 'error'): void;
  onMetrics?(metrics: PromptInputMetrics): void;
  panel?: ReactNode;
  seed?: { text: string; seq: number } | null;
}

export function DraftView({
  width,
  height,
  focused,
  borderless,
  context,
  splashLines,
  trayLeft,
  onStart,
  onCommand,
  onToast,
  onMetrics,
  panel = null,
  seed: hostSeed = null,
}: DraftViewProps) {
  const [starting, setStarting] = useState(false);
  const [restore, setRestore] = useState<{ text: string; seq: number } | null>(null);

  const start = useCallback(
    (prompt: string) => {
      if (!context.hasProject) {
        onToast('No project selected. Type /projects to pick one.', 'error');
        setRestore((current) => ({ text: prompt, seq: (current?.seq ?? 0) + 1 }));
        return;
      }
      setStarting(true);
      onStart(prompt)
        .catch(() => {
          // The app already toasted the reason. Give the prompt back.
          setRestore((current) => ({ text: prompt, seq: (current?.seq ?? 0) + 1 }));
        })
        .finally(() => setStarting(false));
    },
    [context.hasProject, onStart, onToast],
  );

  const run = useCallback(
    (entry: MenuEntry, args: string) => {
      // No session: the only runtime commands a project has run inside one.
      if (entry.source === 'runtime') return;
      onCommand(entry.name as CommandName, args);
    },
    [onCommand],
  );

  const hasPanel = panel !== null;
  const reportMetrics = useCallback(
    (metrics: PromptInputMetrics) =>
      onMetrics?.(
        hasPanel ? { ...metrics, aboveRows: PICKER_RESERVE_ROWS, menuOpen: false } : metrics,
      ),
    [hasPanel, onMetrics],
  );

  const frame = borderless ? 0 : 2;
  const innerWidth = Math.max(width - frame - 2, 12);
  const seed = restore && (!hostSeed || restore.seq > hostSeed.seq) ? restore : hostSeed;

  const tray = (
    <box flexDirection="row" justifyContent="space-between" height={1} paddingLeft={1} paddingRight={1}>
      <text fg={theme.faint} wrapMode="none">
        {trayLeft}
      </text>
      <text fg={theme.dim} wrapMode="none">
        {starting ? 'starting a session…' : 'new session'}
      </text>
    </box>
  );

  return (
    <Panel borderless={borderless} focused={focused} flexGrow={1} minWidth={20}>
      <box
        flexDirection="column"
        height={Math.max(height - frame, 1)}
        paddingLeft={1}
        paddingRight={1}
        overflow="hidden"
      >
        <box flexDirection="column" flexGrow={1} flexShrink={1} justifyContent="center" overflow="hidden">
          <Splash
            width={innerWidth}
            center
            tagline={
              context.hasProject
                ? 'Type a prompt to start a session. / lists every command.'
                : 'No project yet. Type /projects to pick one.'
            }
            lines={splashLines}
          />
          {starting ? (
            <box paddingLeft={2} marginTop={1}>
              <Spinner label="Starting a session…" />
            </box>
          ) : null}
        </box>

        {panel}

        <PromptInput
          focused={focused && !panel && !starting}
          width={innerWidth}
          placeholder="What should Kortix do?"
          context={context}
          busy={false}
          onSubmit={start}
          onCommand={run}
          onToast={onToast}
          onMetrics={reportMetrics}
          seed={seed}
          footer={tray}
        />
      </box>
    </Panel>
  );
}
