/**
 * useSkillMentions — hook for `#`-skill detection, querying, tracking, and
 * submit-time resolution.
 *
 * COR-160 remaining part: the Skills page was removed from mobile, so a
 * skill must stay reachable from the composer. Mirrors `useMentions.ts`'s
 * `@`-detection shape (walk backward from the cursor, track picked items,
 * prune them on delete) with `#` as the trigger and the project's SKILL
 * commands (`Command.source === 'skill'`, the same "Skills" bucket
 * `apps/web`'s `/` menu shows) as the source. All the pure decision logic
 * lives in `lib/session/skill-mentions.ts` (bun-tested); this hook is the
 * thin React state wrapper around it, same division as `useMentions.ts`.
 */

import { useState, useCallback, useMemo, useEffect } from 'react';
import type { Command } from '@/lib/opencode/hooks/use-opencode-data';
import {
  detectSkillTrigger,
  filterSkills,
  insertSkillToken,
  pruneSkillMentions,
  resolveSkillSubmission,
  type SkillSubmissionPlan,
  type SkillTriggerMatch,
  type TrackedSkillMention,
} from '@/lib/session/skill-mentions';
import type { MentionItem } from './useMentions';

export type { TrackedSkillMention } from '@/lib/session/skill-mentions';

interface UseSkillMentionsOptions {
  commands: Command[];
}

const SUGGESTION_LIMIT = 20;

export function useSkillMentions({ commands }: UseSkillMentionsOptions) {
  const [trigger, setTrigger] = useState<SkillTriggerMatch | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [mentions, setMentions] = useState<TrackedSkillMention[]>([]);

  const isOpen = trigger !== null;
  const query = trigger?.query ?? '';

  const skills = useMemo(
    () =>
      commands
        .filter((c) => c.source === 'skill')
        .map((c) => ({ name: c.name, description: c.description })),
    [commands],
  );

  const items = useMemo<MentionItem[]>(() => {
    if (!trigger) return [];
    return filterSkills(skills, trigger.query)
      .slice(0, SUGGESTION_LIMIT)
      .map((s) => ({ kind: 'skill' as const, label: s.name, description: s.description }));
  }, [skills, trigger]);

  // Clamp index when items change — mirrors `useMentions.ts`.
  useEffect(() => {
    if (items.length > 0) {
      setSelectedIndex((i) => Math.min(i, items.length - 1));
    }
  }, [items.length]);

  // On React Native we don't get cursor position from onChangeText — the
  // caller passes cursorPos (matches `useMentions.ts`'s own contract).
  const handleTextChange = useCallback(
    (text: string, cursorPos: number) => {
      const match = detectSkillTrigger(text, cursorPos);
      // Don't re-trigger for an already-tracked skill (exact match only) —
      // mirrors `useMentions.ts`'s `isAlreadyTracked` check.
      const isAlreadyTracked = match ? mentions.some((m) => m.label === match.query) : false;
      if (match && !isAlreadyTracked) {
        setTrigger(match);
        setSelectedIndex(0);
      } else {
        setTrigger(null);
      }

      // Prune tracked mentions whose #label text was deleted.
      setMentions((prev) => pruneSkillMentions(text, prev));
    },
    [mentions],
  );

  const selectSkill = useCallback(
    (item: MentionItem, text: string): string => {
      if (!trigger) return text;
      const newText = insertSkillToken(text, trigger, item.label);
      setMentions((prev) =>
        prev.some((m) => m.label === item.label) ? prev : [...prev, { label: item.label }],
      );
      setTrigger(null);
      setSelectedIndex(0);
      return newText;
    },
    [trigger],
  );

  const moveUp = useCallback(() => {
    setSelectedIndex((i) => Math.max(0, i - 1));
  }, []);

  const moveDown = useCallback(() => {
    setSelectedIndex((i) => Math.min(items.length - 1, i + 1));
  }, [items.length]);

  const dismiss = useCallback(() => {
    setTrigger(null);
    setSelectedIndex(0);
  }, []);

  const reset = useCallback(() => {
    setMentions([]);
    setTrigger(null);
    setSelectedIndex(0);
  }, []);

  /** Resolve the current draft at submit time — see `resolveSkillSubmission`'s doc comment. */
  const resolveSubmission = useCallback(
    (text: string, hasAttachments = false): SkillSubmissionPlan =>
      resolveSkillSubmission({ text, mentions, commands, hasAttachments }),
    [mentions, commands],
  );

  return {
    isOpen,
    query,
    items,
    selectedIndex,
    mentions,
    handleTextChange,
    selectSkill,
    moveUp,
    moveDown,
    dismiss,
    reset,
    resolveSubmission,
  };
}
