import { createContext, type ReactNode } from 'react';

import type { MentionSection, MenuRow } from './menu-items';

/**
 * The `@` menu inside a space (flag `chat`): People, then Agents, nothing
 * else. A space composer (and its thread's reply composer) provides it
 * through `SpaceMentionContext`; every other composer keeps the session menu
 * (agents, sessions, files) unchanged.
 */

/** A member of the space the menu can mention. */
export interface SpaceMentionPerson {
  userId: string;
  /** The display name: the chip shows it. */
  name: string;
  /** What the message carries after `@`: the email when known, else the display name. */
  token: string;
  /** The quiet second line: the person's role or email. */
  secondary?: string | null;
  avatarUrl?: string | null;
}

/** An agent the menu can mention: the space's own first, then the project's others. */
export interface SpaceMentionAgent {
  /** The agent's name (slug): what the message carries. */
  name: string;
  /** The display name ("My Kortix"). */
  label: string;
  description?: string | null;
  /** False: not in this space. Naming it does not add it: the composer asks after the send (`renderOutsideAsk`). */
  inSpace: boolean;
}

export interface SpaceMentionSource {
  people: SpaceMentionPerson[];
  agents: SpaceMentionAgent[];
  /**
   * The ask shown above the composer after a send named an agent from outside
   * the space: "Add it?" for a person who may edit the space, else who to ask.
   * `done` dismisses it. Absent: agents outside the space are not offered.
   */
  renderOutsideAsk?: (agent: string, done: () => void) => ReactNode;
  /** Group headings and the "Not in #space" line, in the host's words. */
  labels: { people: string; agents: string; addToSpace: string };
}

export const SpaceMentionContext = createContext<SpaceMentionSource | null>(null);

/** Shown at most, as the menu's height allows about eight rows. */
const LIMIT = 8;

/**
 * How well `query` matches one of `fields`: 3 a prefix, 2 a word prefix,
 * 1 a substring, 0.5 the letters in order (fuzzy), 0 none.
 */
export function mentionScore(query: string, fields: readonly (string | null | undefined)[]): number {
  const q = query.trim().toLowerCase();
  if (!q) return 1;
  let best = 0;
  for (const raw of fields) {
    const field = (raw ?? '').toLowerCase();
    if (!field) continue;
    if (field.startsWith(q)) best = Math.max(best, 3);
    else if (field.split(/[\s._@-]+/).some((word) => word.startsWith(q))) best = Math.max(best, 2);
    else if (field.includes(q)) best = Math.max(best, 1);
    else {
      let at = 0;
      for (const ch of field) if (ch === q[at]) at += 1;
      if (at === q.length) best = Math.max(best, 0.5);
    }
  }
  return best;
}

function ranked<T>(items: readonly T[], score: (item: T) => number): T[] {
  return items
    .map((item, order) => ({ item, order, score: score(item) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .map((entry) => entry.item);
}

/** The menu's sections for a space: People, then Agents (the space's own first). */
export function buildSpaceMentionSections(source: SpaceMentionSource, query: string): MentionSection[] {
  let index = 0;
  const sections: MentionSection[] = [];
  const people = ranked(source.people, (p) => mentionScore(query, [p.name, p.token])).slice(0, LIMIT);
  if (people.length) {
    sections.push({
      kind: 'person',
      heading: source.labels.people,
      items: people.map(
        (p): MenuRow => ({
          index: index++,
          kind: 'person',
          label: p.name,
          value: p.token,
          description: p.secondary ?? undefined,
          avatar: { kind: 'person', key: p.userId, name: p.name, url: p.avatarUrl ?? null },
        }),
      ),
    });
  }
  const offered = source.agents.filter((a) => a.inSpace || !!source.renderOutsideAsk);
  // The space's own agents first among equal matches; a miss stays a miss.
  const agents = ranked(offered, (a) => {
    const score = mentionScore(query, [a.label, a.name]);
    return score > 0 && a.inSpace ? score + 0.1 : score;
  }).slice(0, LIMIT);
  if (agents.length) {
    sections.push({
      kind: 'agent',
      heading: source.labels.agents,
      items: agents.map(
        (a): MenuRow => ({
          index: index++,
          kind: 'agent',
          label: a.label,
          value: a.name,
          description: a.inSpace ? (a.description ?? undefined) : source.labels.addToSpace,
          avatar: { kind: 'agent', key: a.name, name: a.label, url: null },
          addToSpace: !a.inSpace,
        }),
      ),
    });
  }
  return sections;
}

/**
 * The agents outside the space that `text` names (`@name`, the token a mention
 * chip sends), in order, each once. The router never hands work to them.
 */
export function outsideAgentMentions(source: SpaceMentionSource, text: string): string[] {
  if (!source.renderOutsideAsk) return [];
  const outside = new Map(source.agents.filter((a) => !a.inSpace).map((a) => [a.name.toLowerCase(), a.name]));
  const found: string[] = [];
  for (const match of text.matchAll(/(?:^|[^\w@])@([\w.+-]+)/g)) {
    const name = outside.get(match[1]!.replace(/[.]+$/, '').toLowerCase());
    if (name && !found.includes(name)) found.push(name);
  }
  return found;
}
