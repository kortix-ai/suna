/**
 * `Ctrl+P` — the quick switcher (SPEC §6).
 *
 * One flat, filterable list of this project's sessions plus every project on
 * the host. It is a ROOT-level overlay: `ui/Picker` wraps `ui/Modal`, which is
 * absolutely positioned at the terminal origin and would be scissored to the
 * panel rectangle if a feature mounted it (see the note on `ui/Modal`).
 * `app.tsx` mounts it in its overlay slot.
 *
 * Data is the same two reads the sidebar already makes, through the same two
 * SDK hooks and therefore the same two cache entries: `useProjectSessions`
 * and `useProjects`. Opening the switcher costs no extra request on a warm
 * cache — which is only true because both readers share the SDK's key, not a
 * key of their own.
 */

import { useProjectSessions, useProjects } from '@kortix/sdk/react';
import { useMemo } from 'react';

import { relativeAge } from '../../lib/relative-time.ts';
import { type SessionLike, sessionActivityMs, sessionTitle } from '../../lib/session-groups.ts';
import { glyph } from '../../theme.ts';
import { type ListItem, Picker } from '../../ui/index.ts';

const SESSION_PREFIX = 'session:';
const PROJECT_PREFIX = 'project:';

/** What a picked row means. */
export type SwitcherPick =
  | { kind: 'session'; sessionId: string }
  | { kind: 'project'; projectId: string };

/** Decode a row id. Unknown ids resolve to null rather than guessing. */
export function resolveSwitcherItem(id: string): SwitcherPick | null {
  if (id.startsWith(SESSION_PREFIX)) return { kind: 'session', sessionId: id.slice(8) };
  if (id.startsWith(PROJECT_PREFIX)) return { kind: 'project', projectId: id.slice(8) };
  return null;
}

/** Status glyph, same vocabulary the sidebar prints. */
function statusGlyph(status: string | undefined): string {
  if (status === 'failed') return glyph.failed;
  if (status === 'running' || status === 'queued' || status === 'branching') return glyph.running;
  if (status === 'provisioning') return glyph.running;
  return glyph.stopped;
}

export interface SwitcherRowSource {
  sessions: readonly SessionLike[];
  projects: readonly { project_id: string; name: string }[];
  activeProjectId: string | null;
  now: number;
}

/**
 * The rows, sessions first.
 *
 * Sessions are what a switcher is for; projects are the second-order jump and
 * sort under them. The active project is marked, never hidden — a switcher
 * that drops the row you are on reads as a bug.
 */
export function switcherItems(source: SwitcherRowSource): ListItem[] {
  const items: ListItem[] = source.sessions.map((session) => ({
    id: `${SESSION_PREFIX}${session.session_id}`,
    label: sessionTitle(session),
    glyph: statusGlyph(session.status),
    right: relativeAge(sessionActivityMs(session), source.now),
  }));
  for (const project of source.projects) {
    items.push({
      id: `${PROJECT_PREFIX}${project.project_id}`,
      label: `project · ${project.name}`,
      right: project.project_id === source.activeProjectId ? 'active' : '',
      dim: true,
    });
  }
  return items;
}

export interface SwitcherProps {
  projectId: string | null;
  accountId: string | null;
  onPick(pick: SwitcherPick): void;
  onClose(): void;
}

export function Switcher({ projectId, accountId, onPick, onClose }: SwitcherProps) {
  const sessionsQuery = useProjectSessions(projectId ?? '', { enabled: Boolean(projectId) });
  const projectsQuery = useProjects(accountId ?? undefined);

  const items = useMemo(
    () =>
      switcherItems({
        sessions: sessionsQuery.sessions,
        projects: projectsQuery.data ?? [],
        activeProjectId: projectId,
        now: Date.now(),
      }),
    [sessionsQuery.sessions, projectsQuery.data, projectId],
  );

  return (
    <Picker
      title="Go to"
      items={items}
      placeholder={sessionsQuery.isLoading ? 'loading sessions…' : 'Type to filter'}
      onPick={(item) => {
        const pick = resolveSwitcherItem(item.id);
        if (pick) onPick(pick);
      }}
      onClose={onClose}
      width={72}
      height={20}
    />
  );
}
