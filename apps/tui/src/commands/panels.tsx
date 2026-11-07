/**
 * The lists a slash command opens above the input: `/sessions`, `/workspaces`,
 * `/agents`, `/workflows`, `/tasks`, and the y/N confirm a destructive command
 * asks.
 *
 * They are in-flow `InlinePicker`s, like the model picker, so they sit right
 * where the user is typing and never cover the transcript. Each one reads the
 * SAME SDK reads the sidebar and the switcher read (`useProjectSessions`,
 * `useWorkspaces`), so opening one costs no request on a warm cache.
 */

import { useProjectSessions } from '@kortix/sdk/react';
import { useKeyboard } from '@opentui/react';
import { useMemo } from 'react';

import { AgentsPanel } from '../features/agents/agents-panel.tsx';
import { TasksPanel } from '../features/agents/tasks-panel.tsx';
import { InlinePicker } from '../features/session/pickers/inline-picker.tsx';
import { relativeAge } from '../lib/relative-time.ts';
import { sessionActivityMs, sessionTitle } from '../lib/session-groups.ts';
import { matchesBinding } from '../keymap.ts';
import { glyph, theme } from '../theme.ts';
import type { ListItem } from '../ui/index.ts';
import { printable } from '../lib/printable.ts';
import { NO_WORKSPACE_TEXT, useWorkspaces } from '../lib/workspaces.ts';

/** What the panel slot holds. Null = nothing above the input. */
export type CommandPanel =
  | { kind: 'sessions'; query: string }
  /** `/workspaces`: every workspace, one flat list. */
  | { kind: 'workspaces'; query: string }
  | { kind: 'confirm'; title: string; yes: string; action: ConfirmAction }
  | { kind: 'status'; lines: readonly { label: string; value: string }[] }
  /** `/agents`: this session's agents, workflow runs and held messages. */
  | { kind: 'agents' }
  /** `/workflows`: the same panel, workflow runs only. */
  | { kind: 'workflows' }
  /** `/tasks`: the team's shared task list. */
  | { kind: 'tasks' }
  /** `/ui` and the first-run layout picker. `app.tsx` draws it (it owns the layout). */
  | { kind: 'ui'; welcome: boolean };

/** What a confirmed panel runs. Data, so the panel stays a pure view. */
export type ConfirmAction = { kind: 'delete-session'; sessionId: string };

/** Status glyph, the same vocabulary the sidebar prints. */
export function sessionGlyph(status: string | undefined): string {
  if (status === 'failed') return glyph.failed;
  if (status === 'running' || status === 'queued' || status === 'branching') return glyph.running;
  if (status === 'provisioning') return glyph.running;
  return glyph.stopped;
}

interface SessionRowSource {
  session_id: string;
  status?: string;
  pinned_at?: string | null;
}

/**
 * The `/sessions` rows. Pinned first, then the API's order (newest activity
 * first). The open session is marked `open`, never hidden.
 */
export function sessionItems(
  sessions: readonly (SessionRowSource & Parameters<typeof sessionTitle>[0])[],
  openSessionId: string | null,
  now: number,
): ListItem[] {
  const pinned = sessions.filter((session) => session.pinned_at);
  const rest = sessions.filter((session) => !session.pinned_at);
  return [...pinned, ...rest].map((session) => ({
    id: session.session_id,
    label: `${session.pinned_at ? '↑ ' : ''}${printable(sessionTitle(session))}`,
    glyph: sessionGlyph(session.status),
    right:
      session.session_id === openSessionId
        ? 'open'
        : relativeAge(sessionActivityMs(session as Parameters<typeof sessionActivityMs>[0]), now),
  }));
}

export interface PanelProps {
  panel: CommandPanel;
  width: number;
  projectId: string | null;
  accountId: string | null;
  sessionId: string | null;
  onClose(): void;
  onOpenSession(sessionId: string): void;
  /** A workspace row: its `project_id` and the account that owns it. */
  onPickWorkspace(projectId: string, accountId: string): void;
  onConfirm(action: ConfirmAction): void;
}

export function CommandPanelView(props: PanelProps) {
  const { panel } = props;
  if (panel.kind === 'sessions') return <SessionsPanel {...props} query={panel.query} />;
  if (panel.kind === 'workspaces') return <WorkspacesPanel {...props} query={panel.query} />;
  if (panel.kind === 'status')
    return <StatusPanel lines={panel.lines} width={props.width} onClose={props.onClose} />;
  if (panel.kind === 'agents' || panel.kind === 'workflows')
    return (
      <AgentsPanel
        projectId={props.projectId}
        sessionId={props.sessionId}
        width={props.width}
        only={panel.kind === 'workflows' ? 'workflows' : 'all'}
        onClose={props.onClose}
      />
    );
  if (panel.kind === 'tasks')
    return (
      <TasksPanel
        projectId={props.projectId}
        sessionId={props.sessionId}
        width={props.width}
        onClose={props.onClose}
      />
    );
  if (panel.kind === 'ui') return null;
  return (
    <InlinePicker
      title={panel.title}
      items={[
        { id: 'yes', label: `${panel.yes}  (y)` },
        { id: 'no', label: 'Cancel  (n)' },
      ]}
      initialId="no"
      shortcuts={{ y: 'yes', n: 'no' }}
      width={props.width}
      hint="y yes · n no · Enter choose · Esc cancel"
      onClose={props.onClose}
      onPick={(item) => {
        props.onClose();
        if (item.id === 'yes') props.onConfirm(panel.action);
      }}
    />
  );
}

function SessionsPanel({
  width,
  projectId,
  sessionId,
  query,
  onClose,
  onOpenSession,
}: PanelProps & { query: string }) {
  const sessionsQuery = useProjectSessions(projectId ?? '', { enabled: Boolean(projectId) });
  const items = useMemo(
    () => sessionItems(sessionsQuery.sessions, sessionId, Date.now()),
    [sessionsQuery.sessions, sessionId],
  );
  const title = sessionsQuery.isLoading
    ? 'Sessions · loading…'
    : `Sessions · ${items.length}${sessionsQuery.hasNextPage ? '+' : ''}`;
  return (
    <InlinePicker
      title={title}
      items={items}
      initialId={sessionId}
      initialQuery={query}
      width={width}
      maxRows={10}
      hint="Enter open · Esc close"
      onClose={onClose}
      onPick={(item) => {
        onClose();
        onOpenSession(item.id);
      }}
    />
  );
}

function WorkspacesPanel({
  width,
  projectId,
  query,
  onClose,
  onPickWorkspace,
}: PanelProps & { query: string }) {
  const workspaces = useWorkspaces();
  const items = useMemo<ListItem[]>(
    () =>
      workspaces.rows.map((row) => ({
        id: row.id,
        label: row.name,
        right: row.id === projectId ? 'open' : '',
      })),
    [workspaces.rows, projectId],
  );
  const empty = !workspaces.isLoading && !workspaces.isError && items.length === 0;
  return (
    <InlinePicker
      title={workspaces.isLoading ? 'Workspaces · loading…' : `Workspaces · ${items.length}`}
      items={items}
      initialId={projectId}
      initialQuery={query}
      width={width}
      hint={empty ? NO_WORKSPACE_TEXT : 'Enter open · Esc close'}
      onClose={onClose}
      onPick={(item) => {
        onClose();
        const picked = workspaces.rows.find((row) => row.id === item.id);
        if (picked) onPickWorkspace(picked.id, picked.accountId);
      }}
    />
  );
}

/** `/status`: one `label value` line per fact. Esc or Enter closes it. */
function StatusPanel({
  lines,
  width,
  onClose,
}: {
  lines: readonly { label: string; value: string }[];
  width: number;
  onClose(): void;
}) {
  useKeyboard((key) => {
    if (matchesBinding(key, 'back') || key.name === 'return') {
      key.preventDefault();
      onClose();
    }
  });
  const labelWidth = Math.max(...lines.map((line) => line.label.length), 0) + 2;
  const room = Math.max(width - 4 - labelWidth, 8);
  return (
    <box
      border
      borderStyle="rounded"
      borderColor={theme.border}
      title=" Status "
      titleColor={theme.dim}
      backgroundColor={theme.bg}
      bottomTitle=" Esc close "
      bottomTitleAlignment="right"
      flexDirection="column"
      width={width}
      paddingLeft={1}
      paddingRight={1}
    >
      {lines.map((line) => (
        <text key={line.label} wrapMode="none" height={1}>
          <span fg={theme.faint}>{line.label.padEnd(labelWidth)}</span>
          <span fg={theme.fg}>
            {line.value.length > room ? `${line.value.slice(0, room - 1)}…` : line.value}
          </span>
        </text>
      ))}
    </box>
  );
}
