/**
 * The info panel: the open session at a glance, docked left or right.
 *
 * Title, state, context use, model, agent, the session itself and its
 * forwarded ports — the column opencode and the web's session panel keep
 * beside the chat. It is a module (`layout/ui-prefs.ts`, `/info`, `Alt+I`):
 * off until you turn it on.
 *
 * `session-view.tsx` renders it, because it reads the session's one
 * `useSession` result: a second hook call here would be a second lifecycle
 * driver for the same session (SPEC §1.3). Everything it shows comes from that
 * object, the thread on screen and the ports rows. It has no keys.
 *
 * Context use is the web's rule (`packages/ui/.../context-usage.ts`): the last
 * reply with usage (`sessionLogThreadMetrics(...).context`), counting input,
 * output and cache — reasoning is a subset of output and is not added twice —
 * against the selected model's context window, when one is known.
 */

import {
  type SessionLogMessage,
  type SessionLogThread,
  sessionLogThreadMetrics,
} from '@kortix/sdk';
import type { UseSessionResult } from '@kortix/sdk/react';
import { useMemo } from 'react';

import { contextReading } from '../lib/context-usage.ts';
import { relativeAge } from '../lib/relative-time.ts';
import { glyph, theme } from '../theme.ts';

/** Columns the panel takes, its left or right rule included. */
export const INFO_PANEL_WIDTH = 34;

export interface InfoPanelProps {
  session: UseSessionResult;
  thread: Pick<SessionLogThread, 'messages'> | null | undefined;
  title: string;
  sessionId: string;
  /** `host · project`, the panel's footer. */
  footer: string;
  /** Local ports forwarded from this session's sandbox. */
  forwarded: readonly number[];
  height: number;
  now?: number;
}

function Section({ label, lines }: { label: string; lines: readonly string[] }) {
  return (
    <box flexDirection="column" marginTop={1} flexShrink={0}>
      <text fg={theme.fg} wrapMode="none" height={1}>
        <b>{label}</b>
      </text>
      {lines.map((line) => (
        <text key={`${label}:${line}`} fg={theme.dim} wrapMode="none" height={1}>
          {line}
        </text>
      ))}
    </box>
  );
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function InfoPanel({
  session,
  thread,
  title,
  sessionId,
  footer,
  forwarded,
  height,
  now = Date.now(),
}: InfoPanelProps) {
  const inner = INFO_PANEL_WIDTH - 4;
  // The model: the one picked in this session, else the one that produced the
  // last reply (a session on the project default has no pick).
  const contextMessage = thread
    ? (sessionLogThreadMetrics(thread as SessionLogThread).context as SessionLogMessage | null)
    : null;
  const picked = session.picks.model;
  const used = contextMessage?.model;
  const model = useMemo(
    () =>
      (session.models ?? []).find((entry) =>
        picked
          ? entry.providerID === picked.providerID && entry.modelID === picked.modelID
          : used
            ? entry.modelID === used.model &&
              (entry.providerID === used.provider || entry.provider === used.provider)
            : false,
      ),
    [session.models, picked, used],
  );
  const reading = contextReading(
    thread,
    model?.contextWindow && model.contextWindow > 0 ? model.contextWindow : null,
  );
  const messages = thread?.messages ?? [];
  const turns = messages.filter((message) => message.role === 'user').length;
  const firstAt = messages[0]?.created_at ? Date.parse(messages[0].created_at) : Number.NaN;

  const state =
    session.phase === 'ready'
      ? session.isBusy
        ? 'working'
        : 'ready'
      : (session.stage ?? session.phase);
  const stateGlyph =
    session.phase === 'error'
      ? glyph.failed
      : session.phase === 'ready'
        ? glyph.running
        : glyph.stopped;

  return (
    <box
      flexDirection="column"
      width={INFO_PANEL_WIDTH}
      height={height}
      flexShrink={0}
      backgroundColor={theme.surface}
      paddingLeft={2}
      paddingRight={2}
      paddingTop={1}
    >
      <text fg={theme.fg} wrapMode="word" flexShrink={0}>
        <b>{title}</b>
      </text>
      <text fg={theme.dim} wrapMode="none" height={1} flexShrink={0}>
        <span fg={session.phase === 'error' ? theme.danger : theme.fg}>{`${stateGlyph} `}</span>
        {clip(`${state}${session.agentName ? ` · ${session.agentName}` : ''}`, inner - 2)}
      </text>

      <Section
        label="Context"
        lines={
          reading.tokens > 0
            ? [
                `${reading.tokens.toLocaleString('en-US')} tokens`,
                ...(reading.percent !== null ? [`${reading.percent}% used`] : []),
              ]
            : ['nothing yet']
        }
      />
      <Section
        label="Model"
        lines={[clip(model?.modelName ?? used?.model ?? 'project default', inner)]}
      />
      <Section
        label="Session"
        lines={[
          sessionId.slice(0, 8),
          `${turns} ${turns === 1 ? 'prompt' : 'prompts'}${Number.isFinite(firstAt) ? ` · ${relativeAge(firstAt, now)}` : ''}`,
        ]}
      />
      {forwarded.length > 0 ? (
        <Section label="Ports" lines={forwarded.map((port) => `⇄ ${port} → localhost:${port}`)} />
      ) : null}

      <box flexGrow={1} />
      <text fg={theme.faint} wrapMode="none" height={1} flexShrink={0}>
        {clip(footer, inner)}
      </text>
    </box>
  );
}
