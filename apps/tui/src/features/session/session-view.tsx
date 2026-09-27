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

import { type MessageWithParts, classifyTurn } from '@kortix/sdk';
import { useSession } from '@kortix/sdk/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { ResolvedHost } from '../../auth/hosts.ts';
import { hintFor } from '../../keymap.ts';
import { extractUrls, extractUrlsFromScreen } from '../../lib/links.ts';
import { glyph, theme } from '../../theme.ts';
import { Panel, type ToastKind } from '../../ui/index.ts';
import { type LinkRow, sameLinks, withLinks } from '../links/index.ts';
import { type UsePortsResult, detectForwardablePorts, usePorts } from '../ports/index.ts';
import { TerminalPanel } from '../terminal/terminal-panel.tsx';
import { Composer } from './composer/composer.tsx';
import type { AppCommandId } from './composer/slash-commands.ts';
import { SessionPrompts, Transcript } from './transcript/index.ts';

/** Every assistant text part and tool output in the transcript, joined by newlines. */
export function transcriptText(messages: readonly MessageWithParts[]): string {
  const texts: string[] = [];
  for (const message of messages) {
    if (message.info.role !== 'assistant') continue;
    for (const part of classifyTurn(message).parts) {
      if (part.kind === 'text') texts.push(part.text);
      else if (part.kind === 'tool' && part.tool.outputText) texts.push(part.tool.outputText);
    }
  }
  return texts.join('\n');
}

/** Every port-forwardable string in an assistant turn's text + tool output. */
export function portsInTranscript(messages: readonly MessageWithParts[]): number[] {
  return detectForwardablePorts(transcriptText(messages));
}

/** Which region inside the session area owns the keyboard. */
export type SessionFocus = 'transcript' | 'composer' | 'terminal';

/** Rows the transcript never goes below, however big the composer grows. */
export const TRANSCRIPT_MIN_ROWS = 3;
/** Upper bound on the rows a pending question/permission card draws. */
export const PROMPT_RESERVE_ROWS = 12;
/** Upper bound on the rows a composer overlay (the `/` palette, a picker) adds. */
export const OVERLAY_RESERVE_ROWS = 12;
/** The composer's fixed chrome: two border rows, the footer, and an error row. */
export const COMPOSER_CHROME_ROWS = 4;

export interface ComposerMetrics {
  /** Text rows the textarea currently needs (1–6). */
  rows: number;
  /** A palette or picker is open above the input. */
  overlayOpen: boolean;
}

/** Rows to keep clear under the transcript. Always ≥ what the composer draws. */
export function composerReserve(metrics: ComposerMetrics): number {
  return metrics.rows + COMPOSER_CHROME_ROWS + (metrics.overlayOpen ? OVERLAY_RESERVE_ROWS : 0);
}

/** The transcript's height for a content box of `contentRows`. */
export function transcriptRows(
  contentRows: number,
  metrics: ComposerMetrics,
  promptOpen: boolean,
): number {
  const reserved = 1 + composerReserve(metrics) + (promptOpen ? PROMPT_RESERVE_ROWS : 0);
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
  onCommand(command: AppCommandId): void;
  onToast(message: string, kind?: ToastKind): void;
  /** Ports panel (`Alt+P`) state, hoisted so `app.tsx` can render its overlay
   *  at the root — same reason `onMetrics` hoists composer metrics. */
  onPortsApi?: (api: UsePortsResult) => void;
  /** Links panel (`Alt+L`) rows, hoisted for the same reason. Newest first. */
  onLinks?: (rows: LinkRow[]) => void;
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
  onCommand,
  onToast,
  onPortsApi,
  onLinks,
  useSessionImpl = useSession,
}: SessionViewProps) {
  // The one call. Every child reads this object; none of them calls a hook.
  const session = useSessionImpl(projectId, sessionId);
  const [metrics, setMetrics] = useState<ComposerMetrics>({ rows: 1, overlayOpen: false });

  const ports = usePorts({ host, projectId, sessionId, onToast });
  useEffect(() => {
    onPortsApi?.(ports);
  }, [ports, onPortsApi]);

  // Assistant text + tool output can name a sandbox port worth forwarding
  // (SPEC: "VS Code-style port forwarding"). Re-scans the whole transcript on
  // every message-shape change; `ports.notice` is a no-op for a port already
  // known, so this is cheap in practice and never double-forwards.
  // biome-ignore lint/correctness/useExhaustiveDependencies(ports.notice): stable (see `usePorts`'s memoized return); only a transcript change should retrigger this scan.
  useEffect(() => {
    const found = portsInTranscript(session.messages as unknown as MessageWithParts[]);
    if (found.length) ports.notice(found, 'transcript');
  }, [session.messages]);

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
    noticeLinks(
      extractUrls(transcriptText(session.messages as unknown as MessageWithParts[])),
      'transcript',
    );
  }, [session.messages]);

  const onMetrics = useCallback((next: ComposerMetrics) => {
    setMetrics((current) =>
      current.rows === next.rows && current.overlayOpen === next.overlayOpen ? current : next,
    );
  }, []);

  const focusComposer = useCallback(() => onFocus('composer'), [onFocus]);

  const sessionWidth = terminalOpen && wide ? Math.max(width - terminalWidth(width), 20) : width;
  const showSession = !terminalOpen || wide;

  const contentRows = Math.max(height - 2, 1);
  const innerWidth = Math.max(sessionWidth - 4, 12);
  const promptOpen = session.questions.length > 0 || session.permissions.length > 0;
  const rows = transcriptRows(contentRows, metrics, promptOpen);

  const header = useMemo(() => {
    const parts: string[] = [];
    if (session.phase !== 'ready') parts.push(session.stage ?? session.phase);
    if (session.agentName) parts.push(session.agentName);
    return parts.join(' · ');
  }, [session.phase, session.stage, session.agentName]);

  return (
    <>
      {showSession ? (
        <Panel
          focused={focus === 'transcript' || focus === 'composer'}
          width={sessionWidth}
          flexGrow={0}
          flexShrink={1}
          minWidth={20}
        >
          <box
            flexDirection="column"
            height={contentRows}
            paddingLeft={1}
            paddingRight={1}
            overflow="hidden"
          >
            <box flexDirection="row" height={1} justifyContent="space-between">
              <text fg={theme.fg} wrapMode="none">
                <span fg={session.phase === 'error' ? theme.danger : theme.accent}>
                  {`${phaseGlyph(session.phase)} `}
                </span>
                {truncate(title ?? 'Session', Math.max(innerWidth - 28, 8))}
                <span fg={theme.faint}>{header ? `  ${header}` : ''}</span>
              </text>
              <text fg={theme.faint} wrapMode="none">
                {`${hintFor('panel.terminal')} terminal`}
              </text>
            </box>

            <Transcript
              session={session}
              focused={focus === 'transcript'}
              width={innerWidth}
              height={rows}
              onToast={onToast}
              renderPrompts={false}
            />

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
              onCommand={onCommand}
              onToast={onToast}
              onRequestFocus={focusComposer}
              onMetrics={onMetrics}
            />
          </box>
        </Panel>
      ) : null}

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

/** The terminal's share of a wide layout: 40%, floored so a shell stays usable. */
export function terminalWidth(total: number): number {
  return Math.max(Math.round(total * 0.4), 32);
}

function truncate(text: string, width: number): string {
  if (width <= 1 || text.length <= width) return text;
  return `${text.slice(0, width - 1)}…`;
}
