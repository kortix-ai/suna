'use client';

import { listRoomPeople, type ProjectSession, type RoomMember, type RoomPerson } from '@kortix/sdk';
import { qk, useProjectSessions } from '@kortix/sdk/react';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState, type KeyboardEvent } from 'react';

import type { ParticipantKind } from './room-identity';
import { MENTION_ID_CHARS, parseSessionLabel, personName, sessionDisplay, type MentionTarget } from './room-text';

/** People the caller may message in the project; `q` filters by name or email on the server. */
export function useRoomPeople(projectId: string, q = '', enabled = true) {
  return useQuery({
    queryKey: [...qk.project.rooms(projectId), 'people', q],
    queryFn: async () => (await listRoomPeople(projectId, q || undefined)).people,
    enabled,
    staleTime: 30_000,
  });
}

/** The project's agent sessions the viewer can see, newest activity first; `q` searches on the server. */
export function useRoomSessions(projectId: string, q = '', enabled = true) {
  return useProjectSessions(projectId, { q: q || undefined, limit: 50, enabled });
}

/** What a person reads for a session row: its title, else its agent, else the short id. */
export function projectSessionTitle(session: ProjectSession): string {
  return session.name ?? (session.agent_name && session.agent_name !== 'default' ? session.agent_name : session.session_id.slice(0, 8));
}

/** Someone a room can name: one row per person or agent session, as every rooms surface reads it. */
export interface PrincipalRow {
  /** The full session or user id. */
  id: string;
  kind: ParticipantKind;
  member: boolean;
  /** The viewer: offered nowhere, highlighted in a chip. */
  self: boolean;
  title: string;
  detail: string | null;
  /** What `ParticipantAvatar` draws from: a member session keeps its full label. */
  avatarLabel: string;
  /** A project session's status; the picker shows it. */
  status?: ProjectSession['status'];
  /** Names the server slugs for a mention, and a person's email. */
  names: string[];
  /** What the composer's `@query` matches, besides the id prefix. */
  search: string;
  /** What the composer inserts: `@` plus the email, else 8 id characters. */
  insert: string;
}

const present = (...values: (string | null | undefined)[]) => values.filter((v): v is string => !!v);

/** A person reads as `personName` of their profile name everywhere; a non-member row adds the email. */
function personRow(id: string, label: string, names: string[], email: string | null, member: boolean, viewerId: string | null): PrincipalRow {
  const title = personName(label);
  return {
    id,
    kind: 'person',
    member,
    self: id === viewerId,
    title,
    detail: !member && email && email !== title ? email : null,
    avatarLabel: title,
    names,
    search: `${title} ${email ?? ''}`,
    insert: email ? `@${email}` : `@${id.slice(0, MENTION_ID_CHARS)}`,
  };
}

/**
 * Everyone a `@token` in this conversation can name: its members first, then
 * the project's sessions and people, each once. Mirrors the server's
 * resolution, so a chip shows exactly who the server notified.
 */
export function principalRows(
  members: readonly RoomMember[],
  sessions: readonly ProjectSession[],
  people: readonly RoomPerson[],
  viewerId: string | null,
): PrincipalRow[] {
  const personById = new Map(people.map((p) => [p.user_id, p]));
  const rows = new Map<string, PrincipalRow>();
  const add = (row: PrincipalRow) => {
    if (!rows.has(row.id)) rows.set(row.id, row);
  };
  for (const m of members) {
    const id = m.session_id ?? m.user_id;
    if (!id) continue;
    if (m.kind === 'session') {
      const { agent, title } = parseSessionLabel(m.label);
      const display = sessionDisplay(m.label);
      add({
        id,
        kind: 'session',
        member: true,
        self: false,
        title: display.name,
        detail: display.detail,
        avatarLabel: m.label,
        names: present(agent, title),
        search: display.name,
        insert: `@${id.slice(0, MENTION_ID_CHARS)}`,
      });
    } else {
      const email = personById.get(id)?.email ?? null;
      add(personRow(id, personById.get(id)?.name ?? m.label, present(m.label, email), email, true, viewerId));
    }
  }
  for (const s of sessions) {
    const agent = s.agent_name && s.agent_name !== 'default' ? s.agent_name : null;
    const title = projectSessionTitle(s);
    add({
      id: s.session_id,
      kind: 'session',
      member: false,
      self: false,
      title,
      detail: s.name ? agent : null,
      avatarLabel: title,
      status: s.status,
      names: present(agent, s.name),
      search: `${title} ${agent ?? ''}`,
      insert: `@${s.session_id.slice(0, MENTION_ID_CHARS)}`,
    });
  }
  for (const p of people) {
    add(personRow(p.user_id, p.name ?? p.email ?? p.user_id.slice(0, 8), present(p.name, p.email), p.email, false, viewerId));
  }
  return [...rows.values()];
}

export function mentionTargets(rows: readonly PrincipalRow[]): MentionTarget[] {
  return rows.map((row) => ({ ids: [row.id], names: row.names, label: row.title, self: row.self }));
}

/** Who the room's composers and chips can name: the members plus the project's sessions and people. */
export interface RoomDirectory {
  rows: PrincipalRow[];
  targets: MentionTarget[];
}

export function useRoomDirectory(projectId: string, members: readonly RoomMember[], viewerId: string | null): RoomDirectory {
  const { sessions } = useRoomSessions(projectId);
  const people = useRoomPeople(projectId);
  return useMemo(() => {
    const rows = principalRows(members, sessions, people.data ?? [], viewerId);
    return { rows, targets: mentionTargets(rows) };
  }, [members, sessions, people.data, viewerId]);
}

/**
 * The keyboard half of a list under a text field: the highlighted row, which
 * returns to the first row whenever `key` (the query) changes, ArrowUp and
 * ArrowDown that wrap, and `pickKeys` that pick the highlighted row.
 * `onKeyDown` returns whether it handled the key.
 */
export function useListNavigation<T>(rows: readonly T[], key: string, onPick: (row: T) => void, pickKeys: readonly string[] = ['Enter']) {
  // The highlight resets to the first row whenever the query changes.
  const [nav, setNav] = useState({ key, index: 0 });
  const active = nav.key === key ? nav.index : 0;
  const setActive = (index: number) => setNav({ key, index });
  const onKeyDown = (event: KeyboardEvent<HTMLElement>): boolean => {
    if (rows.length === 0) return false;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActive((active + step + rows.length) % rows.length);
      return true;
    }
    if (pickKeys.includes(event.key) && !event.nativeEvent.isComposing) {
      event.preventDefault();
      const row = rows[Math.min(active, rows.length - 1)];
      if (row) onPick(row);
      return true;
    }
    return false;
  };
  return { active, setActive, onKeyDown };
}
