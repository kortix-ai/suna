/**
 * The session column: header, transcript, prompts, composer — and, when it is
 * open, the terminal panel beside it.
 *
 * **It calls `useSession(projectId, sessionId)` exactly once** and hands that
 * one object to every child (SPEC §1.3). That is why the terminal panel is
 * rendered here and not by `app.tsx`: the panel needs `session.switched` to
 * know the sandbox is up, and a second `useSession` call in the app would be a
 * second lifecycle driver for one session. The component returns a fragment,
 * so the panel is still a sibling column inside `app.tsx`'s row.
 *
 * ── Sizing ──
 * `Transcript` takes a numeric height (it pages and re-pins against it), so the
 * column cannot simply flex. The budget is:
 *
 *   transcript = content − header(1) − prompt reserve − composer reserve
 *
 * with a `flexGrow` spacer between the transcript and the composer that eats
 * whatever the reserves over-booked. The reserves are upper bounds, so the
 * composer is never clipped off the bottom of the panel, and the spacer means
 * an over-booked reserve costs blank space in the middle instead of a gap under
 * the input. The composer reports its own text rows through `onMetrics`, so
 * ordinary typing is exact and only the overlay case is an estimate.
 */

import {
  type SessionHealthResult,
  type SessionLogMessage,
  classifySessionLogMessage,
} from '@kortix/sdk';
import { useSession, useSessionLogThread, useSessionPrompts } from '@kortix/sdk/react';
import type { BoxRenderable, MouseEvent } from '@opentui/core';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { ResolvedHost } from '../../auth/hosts.ts';
import { printable } from '../../lib/printable.ts';
import { hintFor } from '../../keymap.ts';
import { kortix } from '../../kortix.ts';
import { extractUrls, extractUrlsFromScreen } from '../../lib/links.ts';
import { glyph, theme } from '../../theme.ts';
import type { CommandContext, CommandName } from '../../commands/registry.ts';
import { Panel, Splash, type SplashLine, type ToastKind } from '../../ui/index.ts';
import { type LinkRow, sameLinks, withLinks } from '../links/index.ts';
import { type UsePortsResult, detectForwardablePorts, usePorts } from '../ports/index.ts';
import { TerminalPanel } from '../terminal/terminal-panel.tsx';
import { INFO_PANEL_WIDTH, InfoPanel } from '../../layout/info-panel.tsx';
import { Composer } from './composer/composer.tsx';
import type { PromptInputMetrics } from './composer/prompt-input.tsx';
import { SessionPrompts, Transcript } from './transcript/index.ts';

/** Every assistant text part and tool output in the transcript, joined by newlines. */
export function transcriptText(messages: readonly SessionLogMessage[]): string {
  const texts: string[] = [];
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const part of classifySessionLogMessage(message).parts) {
      if (part.kind === 'text') texts.push(part.text);
      else if (part.kind === 'tool' && part.tool.outputText) texts.push(part.tool.outputText);
    }
  }
  return texts.join('\n');
}

/** Every port-forwardable string in an assistant turn's text + tool output. */
export function portsInTranscript(messages: readonly SessionLogMessage[]): number[] {
  return detectForwardablePorts(transcriptText(messages));
}

/** Which region inside the session area owns the keyboard. */
export type SessionFocus = 'transcript' | 'composer' | 'terminal';

/** Rows the transcript never goes below, however big the composer grows. */
export const TRANSCRIPT_MIN_ROWS = 3;
/** Upper bound on the rows a pending question/permission card draws. */
export const PROMPT_RESERVE_ROWS = 12;
/** The composer's fixed chrome: two border rows, the tray, and an error row. */
export const COMPOSER_CHROME_ROWS = 4;

export type ComposerMetrics = PromptInputMetrics;

/** Rows to keep clear under the transcript. Always ≥ what the composer draws. */
export function composerReserve(metrics: ComposerMetrics): number {
  return metrics.rows + COMPOSER_CHROME_ROWS + metrics.aboveRows;
}

/** The transcript's height for a content box of `contentRows`. */
export function transcriptRows(
  contentRows: number,
  metrics: ComposerMetrics,
  promptOpen: boolean,
  headerRows = 1,
): number {
  const reserved = headerRows + composerReserve(metrics) + (promptOpen ? PROMPT_RESERVE_ROWS : 0);
  return Math.max(contentRows - reserved, TRANSCRIPT_MIN_ROWS);
}

/** The status glyph for a session's lifecycle phase. */
export function phaseGlyph(phase: string): string {
  if (phase === 'error') return glyph.failed;
  if (phase === 'ready') return glyph.running;
  return glyph.stopped;
}

/**
 * The right-hand status-bar hints for the focused region. Exported so the app
 * prints exactly what the keymap says, never a hand-written string.
 */
export function focusHints(focus: SessionFocus | 'sidebar' | 'screen'): string {
  if (focus === 'composer') {
    return `Enter send · Ctrl+J newline · / commands · ${hintFor('composer.model')} model`;
  }
  if (focus === 'transcript') return 'j/k scroll · Enter expand · G newest · Esc composer';
  if (focus === 'terminal') return 'Alt+X close · Alt+Y copy · Ctrl+Q quit';
  if (focus === 'sidebar') return 'Enter open · n new · d delete · / filter';
  return 'Esc back · ? help';
}

export interface SessionViewProps {
  host: ResolvedHost;
  projectId: string;
  sessionId: string;
  /** Display name, resolved from the project's session list. */
  title?: string;
  /** The focused region, or null when focus is elsewhere (the sidebar). */
  focus: SessionFocus | null;
  /** Columns for the whole session + terminal area. */
  width: number;
  /** Rows for that area, status bar excluded. */
  height: number;
  terminalOpen: boolean;
  /** True when there is room to show the terminal beside the session. */
  wide: boolean;
  onFocus(target: SessionFocus): void;
  onCloseTerminal(): void;
  /** What the composer can offer (minus this session's capabilities, read here). */
  context: Omit<CommandContext, 'capabilities' | 'hasSession'>;
  onCommand(command: CommandName, args: string): void;
  onToast(message: string, kind?: ToastKind): void;
  /** The runtime's `/kortix/health` capabilities, hoisted for the app's commands. */
  onCapabilities?: (capabilities: readonly string[] | null) => void;
  /** The composer metrics, hoisted so the app can stand down while the slash menu is open. */
  onComposerMetrics?: (metrics: ComposerMetrics) => void;
  /** A host panel above the input: `/sessions`, `/projects`, a confirm. */
  panel?: ReactNode;
  /** Replace the composer draft (e.g. `/rename <title>`). */
  seed?: { text: string; seq: number } | null;
  /** No frame: the sidebar is hidden and the session fills the screen. */
  borderless?: boolean;
  /** Left side of the tray (`host · project`). */
  trayLeft?: string;
  /** Splash metadata for an empty session. */
  splashLines?: readonly SplashLine[];
  /** The info panel module: docked left or right, or off. */
  info?: 'left' | 'right' | null;
  /** The header module: the title row above the transcript. */
  showHeader?: boolean;
  /** The tray module: the row under the input. */
  showTray?: boolean;
  /** Local ports forwarded from this sandbox, for the info panel. */
  forwardedPorts?: readonly number[];
  /** Each new value starts Game of Life on the empty-session splash (`/life`). */
  lifeSignal?: number;
  /** Ports panel (`Alt+P`) state, hoisted so `app.tsx` can render its overlay
   *  at the root — same reason `onMetrics` hoists composer metrics. */
  onPortsApi?: (api: UsePortsResult) => void;
  /** Links panel (`Alt+L`) rows, hoisted for the same reason. Newest first. */
  onLinks?: (rows: LinkRow[]) => void;
  /** Test seam for the one `/kortix/health` read. */
  readHealth?: (projectId: string, sessionId: string) => Promise<SessionHealthResult>;
  /**
   * Test seam. Production passes nothing and the real `useSession` runs; a test
   * passes a fake so the focus and layout contract can be asserted without an
   * API, a sandbox and an SSE stream. The same pattern `TerminalPanel` uses for
   * its socket factory.
   */
  useSessionImpl?: typeof useSession;
}

export function SessionView({
  host,
  projectId,
  sessionId,
  title,
  focus,
  width,
  height,
  terminalOpen,
  wide,
  onFocus,
  onCloseTerminal,
  context,
  onCommand,
  onToast,
  onCapabilities,
  onComposerMetrics,
  panel = null,
  seed = null,
  borderless = false,
  trayLeft = '',
  splashLines = [],
  info = null,
  showHeader = true,
  showTray = true,
  forwardedPorts = [],
  lifeSignal,
  onPortsApi,
  onLinks,
  readHealth = readSessionHealth,
  useSessionImpl = useSession,
}: SessionViewProps) {
  // The one call. Every child reads this object; none of them calls a hook.
  const session = useSessionImpl(projectId, sessionId);
  const [metrics, setMetrics] = useState<ComposerMetrics>({
    rows: 1,
    aboveRows: 0,
    menuOpen: false,
  });

  // What this runtime serves: one `/kortix/health` read once the runtime is up.
  // Null — not read yet, or the read failed — hides nothing.
  const [capabilities, setCapabilities] = useState<readonly string[] | null>(null);
  useEffect(() => {
    setCapabilities(null);
    if (!session.switched) return;
    let live = true;
    readHealth(projectId, sessionId)
      .then((probe) => {
        if (live) setCapabilities(probe.health?.capabilities ?? null);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [projectId, sessionId, session.switched, readHealth]);
  useEffect(() => {
    onCapabilities?.(capabilities);
  }, [capabilities, onCapabilities]);

  const ports = usePorts({ host, projectId, sessionId, onToast });
  useEffect(() => {
    onPortsApi?.(ports);
  }, [ports, onPortsApi]);

  // Assistant text + tool output can name a sandbox port worth forwarding
  // (SPEC: "VS Code-style port forwarding"). Re-scans the whole transcript on
  // every message-shape change; `ports.notice` is a no-op for a port already
  // known, so this is cheap in practice and never double-forwards.
  // biome-ignore lint/correctness/useExhaustiveDependencies(ports.notice): stable (see `usePorts`'s memoized return); only a transcript change should retrigger this scan.
  const thread = useSessionLogThread(session);
  // One inbox read for the column: the transcript draws its prompts, the composer its count.
  const inbox = useSessionPrompts(projectId, sessionId);
  useEffect(() => {
    const found = portsInTranscript(thread?.messages ?? []);
    if (found.length) ports.notice(found, 'transcript');
  }, [thread]);

  // Links panel rows. A ref, not state: nothing in this column renders them,
  // and a state update per terminal repaint would re-render the transcript.
  const linksRef = useRef<LinkRow[]>([]);
  const noticeLinks = useCallback(
    (urls: string[], source: LinkRow['source']) => {
      if (urls.length === 0) return;
      const next = withLinks(linksRef.current, urls, source);
      if (sameLinks(linksRef.current, next)) return;
      linksRef.current = next;
      onLinks?.(next);
    },
    [onLinks],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies(noticeLinks): only a transcript change should retrigger this scan.
  useEffect(() => {
    noticeLinks(extractUrls(transcriptText(thread?.messages ?? [])), 'transcript');
  }, [thread]);

  const onMetrics = useCallback(
    (next: ComposerMetrics) => {
      setMetrics((current) =>
        current.rows === next.rows &&
        current.aboveRows === next.aboveRows &&
        current.menuOpen === next.menuOpen
          ? current
          : next,
      );
      onComposerMetrics?.(next);
    },
    [onComposerMetrics],
  );

  const focusComposer = useCallback(() => onFocus('composer'), [onFocus]);

  // The info panel docks beside the chat only while the chat keeps 50 columns.
  const infoShown =
    Boolean(info) &&
    width - (terminalOpen && wide ? terminalWidth(width) : 0) - INFO_PANEL_WIDTH >= 50;
  const columnWidth = width - (infoShown ? INFO_PANEL_WIDTH : 0);
  const sessionWidth =
    terminalOpen && wide ? Math.max(columnWidth - terminalWidth(width), 20) : columnWidth;
  const showSession = !terminalOpen || wide;

  const frame = borderless ? 0 : 2;
  const contentRows = Math.max(height - frame, 1);
  const innerWidth = Math.max(sessionWidth - frame - 2, 12);
  // Empty: no message and no prompt the API accepted (a booting session's first prompt is
  // drawn from the inbox, not hidden under the splash).
  const empty =
    (thread?.messages.length ?? 0) === 0 &&
    !session.isBusy &&
    !inbox.prompts.some((p) => !p.synthetic && p.state !== 'failed') &&
    inbox.sent.length === 0;
  const columnRef = useRef<BoxRenderable>(null);
  const [clicks, setClicks] = useState(0);
  const composerContext = useMemo<CommandContext>(
    () => ({ ...context, hasSession: true, capabilities }),
    [context, capabilities],
  );
  const promptOpen = session.questions.length > 0 || session.permissions.length > 0;
  const rows = transcriptRows(contentRows, metrics, promptOpen, showHeader ? 1 : 0);
  // The empty-session splash is sized as if the input were one line with no
  // menu open, so it never moves while you type or open `/`.
  const restingRows = transcriptRows(
    contentRows,
    { rows: 1, aboveRows: 0, menuOpen: false },
    promptOpen,
    showHeader ? 1 : 0,
  );

  // The header is the title and, only while the session is not ready, what it
  // is doing. The agent and the model are the tray's — not printed twice.
  const header = session.phase !== 'ready' ? (session.stage ?? session.phase) : '';

  const infoNode =
    infoShown && showSession ? (
      <InfoPanel
        session={session}
        thread={thread}
        title={title ?? 'Session'}
        sessionId={sessionId}
        footer={trayLeft}
        forwarded={forwardedPorts}
        height={height}
      />
    ) : null;

  return (
    <>
      {info === 'left' ? infoNode : null}
      {showSession ? (
        <Panel
          borderless={borderless}
          focused={focus === 'transcript' || focus === 'composer'}
          width={sessionWidth}
          flexGrow={0}
          flexShrink={1}
          minWidth={20}
        >
          <box
            ref={columnRef}
            flexDirection="column"
            height={contentRows}
            paddingLeft={1}
            paddingRight={1}
            overflow="hidden"
            onMouseDown={(event: MouseEvent) => {
              // An empty session's splash sits under the transcript slot and
              // the composer, so clicks on it arrive here: a click in the slot
              // (above the input and any menu) toggles Game of Life.
              if (!empty || event.button !== 0) return;
              const row = event.y - (columnRef.current?.y ?? 0) - (showHeader ? 1 : 0);
              if (row >= 0 && row < rows) setClicks((value) => value + 1);
            }}
          >
            {showHeader ? (
              <box flexDirection="row" height={1} justifyContent="space-between">
                <text fg={theme.fg} wrapMode="none">
                  <span fg={session.phase === 'error' ? theme.danger : theme.accent}>
                    {`${phaseGlyph(session.phase)} `}
                  </span>
                  {truncate(printable(title ?? 'Session'), Math.max(innerWidth - 28, 8))}
                  <span fg={theme.faint}>{header ? `  ${header}` : ''}</span>
                </text>
                <text fg={theme.faint} wrapMode="none">
                  {`/ commands · ${hintFor('panel.terminal')} terminal`}
                </text>
              </box>
            ) : null}

            {empty ? (
              <>
                {/* A fixed background layer: the input and the menu draw over it. */}
                <box
                  position="absolute"
                  top={showHeader ? 1 : 0}
                  left={1}
                  width={innerWidth}
                  height={restingRows}
                  zIndex={0}
                >
                  <Splash
                    width={innerWidth}
                    height={restingRows}
                    center
                    lifeSignal={(lifeSignal ?? 0) + clicks}
                    tagline="Type a prompt to start. / for commands."
                    lines={splashLines}
                  />
                </box>
                <box height={rows} flexShrink={0} />
              </>
            ) : (
              <Transcript
                session={session}
                focused={focus === 'transcript'}
                pageKeys={focus === 'composer'}
                width={innerWidth}
                height={rows}
                onToast={onToast}
                renderPrompts={false}
                inbox={inbox}
              />
            )}

            <SessionPrompts
              session={session}
              focused={focus === 'transcript' || focus === 'composer'}
              width={innerWidth}
              onToast={onToast}
            />

            {/* Eats whatever the reserves over-booked, so the composer stays
                pinned to the bottom of the column. */}
            <box flexGrow={1} flexShrink={1} />

            <Composer
              session={session}
              projectId={projectId}
              sessionId={sessionId}
              focused={focus === 'composer'}
              width={innerWidth}
              context={composerContext}
              onCommand={onCommand}
              onToast={onToast}
              onRequestFocus={focusComposer}
              onMetrics={onMetrics}
              panel={panel}
              seed={seed}
              trayLeft={trayLeft}
              messages={thread?.messages}
              title={title}
              showTray={showTray}
            />
          </box>
        </Panel>
      ) : null}

      {info !== 'left' ? infoNode : null}
      {terminalOpen ? (
        <TerminalPanel
          projectId={projectId}
          sessionId={sessionId}
          session={session}
          focused={focus === 'terminal'}
          width={wide ? terminalWidth(width) : width}
          height={height}
          onClose={onCloseTerminal}
          onToast={onToast}
          onOutput={(text) => ports.notice(detectForwardablePorts(text), 'terminal')}
          onScreen={(screen) =>
            noticeLinks(extractUrlsFromScreen(screen.lines, screen.columns), 'terminal')
          }
        />
      ) : null}
    </>
  );
}

/** `GET /kortix/health` through the session handle. Async so a throw is a rejection. */
async function readSessionHealth(
  projectId: string,
  sessionId: string,
): Promise<SessionHealthResult> {
  return kortix().session(projectId, sessionId).health();
}

/** The terminal's share of a wide layout: 40%, floored so a shell stays usable. */
export function terminalWidth(total: number): number {
  return Math.max(Math.round(total * 0.4), 32);
}

function truncate(text: string, width: number): string {
  if (width <= 1 || text.length <= width) return text;
  return `${text.slice(0, width - 1)}…`;
}
