/**
 * The lists a slash command opens above the input: `/sessions`, `/projects`,
 * `/accounts`, and the y/N confirm a destructive command asks.
 *
 * They are in-flow `InlinePicker`s, like the model picker, so they sit right
 * where the user is typing and never cover the transcript. Each one reads the
 * SAME SDK hook the sidebar and the switcher read (`useProjectSessions`,
 * `useProjects`, `useAccounts`), so opening one costs no request on a warm
 * cache.
 */

import { useAccounts, useProjectSessions, useProjects } from '@kortix/sdk/react';
import { useKeyboard } from '@opentui/react';
import { useMemo } from 'react';

import { InlinePicker } from '../features/session/pickers/inline-picker.tsx';
import { relativeAge } from '../lib/relative-time.ts';
import { sessionActivityMs, sessionTitle } from '../lib/session-groups.ts';
import { matchesBinding } from '../keymap.ts';
import { glyph, theme } from '../theme.ts';
import type { ListItem } from '../ui/index.ts';

/** What the panel slot holds. Null = nothing above the input. */
export type CommandPanel =
  | { kind: 'sessions'; query: string }
  | { kind: 'projects'; query: string }
  | { kind: 'accounts'; query: string }
  | { kind: 'confirm'; title: string; yes: string; action: ConfirmAction }
  | { kind: 'status'; lines: readonly { label: string; value: string }[] };

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
    label: `${session.pinned_at ? '↑ ' : ''}${sessionTitle(session)}`,
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
  onPickProject(projectId: string, accountId: string | null): void;
  onPickAccount(accountId: string): void;
  onConfirm(action: ConfirmAction): void;
}

export function CommandPanelView(props: PanelProps) {
  const { panel } = props;
  if (panel.kind === 'sessions') return <SessionsPanel {...props} query={panel.query} />;
  if (panel.kind === 'projects') return <ProjectsPanel {...props} query={panel.query} />;
  if (panel.kind === 'accounts') return <AccountsPanel {...props} query={panel.query} />;
  if (panel.kind === 'status') return <StatusPanel lines={panel.lines} width={props.width} onClose={props.onClose} />;
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

function SessionsPanel({ width, projectId, sessionId, query, onClose, onOpenSession }: PanelProps & { query: string }) {
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

function ProjectsPanel({
  width,
  projectId,
  accountId,
  query,
  onClose,
  onPickProject,
}: PanelProps & { query: string }) {
  const projectsQuery = useProjects(accountId ?? undefined);
  const projects = projectsQuery.data ?? [];
  const items = useMemo<ListItem[]>(
    () =>
      projects.map((project) => ({
        id: project.project_id,
        label: project.name,
        right: project.project_id === projectId ? 'open' : '',
      })),
    [projects, projectId],
  );
  return (
    <InlinePicker
      title={projectsQuery.isLoading ? 'Projects · loading…' : `Projects · ${items.length}`}
      items={items}
      initialId={projectId}
      initialQuery={query}
      width={width}
      hint="Enter open · Esc close"
      onClose={onClose}
      onPick={(item) => {
        onClose();
        const picked = projects.find((project) => project.project_id === item.id) as
          | { account_id?: string | null }
          | undefined;
        onPickProject(item.id, picked?.account_id ?? accountId);
      }}
    />
  );
}

function AccountsPanel({ width, accountId, query, onClose, onPickAccount }: PanelProps & { query: string }) {
  const accountsQuery = useAccounts();
  const items = useMemo<ListItem[]>(
    () =>
      (accountsQuery.data ?? []).map((account) => ({
        id: account.account_id,
        label: account.name,
        right: account.account_id === accountId ? 'open' : '',
      })),
    [accountsQuery.data, accountId],
  );
  return (
    <InlinePicker
      title={accountsQuery.isLoading ? 'Accounts · loading…' : `Accounts · ${items.length}`}
      items={items}
      initialId={accountId}
      initialQuery={query}
      width={width}
      hint="Enter open · Esc close"
      onClose={onClose}
      onPick={(item) => {
        onClose();
        onPickAccount(item.id);
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
          <span fg={theme.fg}>{line.value.length > room ? `${line.value.slice(0, room - 1)}…` : line.value}</span>
        </text>
      ))}
    </box>
  );
}
