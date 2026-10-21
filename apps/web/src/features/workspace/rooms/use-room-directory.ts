'use client';

import { listRoomPeople, type ProjectSession, type RoomMember, type RoomPerson } from '@kortix/sdk';
import { qk, useProjectSessions } from '@kortix/sdk/react';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { parseSessionLabel, sessionDisplay, type MentionTarget } from './room-text';

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

/**
 * Everyone a `@token` in this conversation can name: its members first, then
 * the project's sessions and people. Mirrors the server's resolution, so a chip
 * shows exactly who the server notified.
 */
export function useMentionTargets(
  members: readonly RoomMember[],
  sessions: readonly ProjectSession[],
  people: readonly RoomPerson[],
  viewerId: string | null,
): MentionTarget[] {
  return useMemo(() => {
    const seen = new Set<string>();
    const out: MentionTarget[] = [];
    const push = (id: string, target: MentionTarget) => {
      if (seen.has(id)) return;
      seen.add(id);
      out.push(target);
    };
    for (const m of members) {
      const id = m.session_id ?? m.user_id;
      if (!id) continue;
      if (m.kind === 'session') {
        const { agent, title } = parseSessionLabel(m.label);
        const label = sessionDisplay(m.label).name;
        push(id, { ids: [id], names: [agent, title].filter((v): v is string => !!v), label });
      } else {
        const email = people.find((p) => p.user_id === id)?.email;
        push(id, { ids: [id], names: [m.label, email].filter((v): v is string => !!v), label: m.label, self: id === viewerId });
      }
    }
    for (const s of sessions) {
      const agent = s.agent_name && s.agent_name !== 'default' ? s.agent_name : null;
      push(s.session_id, {
        ids: [s.session_id],
        names: [agent, s.name].filter((v): v is string => !!v),
        label: projectSessionTitle(s),
      });
    }
    for (const p of people) {
      const label = p.name ?? p.email ?? p.user_id.slice(0, 8);
      const names = [p.name, p.email].filter((v): v is string => !!v);
      push(p.user_id, { ids: [p.user_id], names, label, self: p.user_id === viewerId });
    }
    return out;
  }, [members, sessions, people, viewerId]);
}
