/**
 * useMentions — hook for @-mention detection, querying, and tracking.
 *
 * Mirrors the frontend's session-chat-input.tsx mention system:
 * - Detects "@" by walking backwards from cursor position
 * - Provides filtered suggestions for agents, sessions, and files
 * - Tracks inserted mentions for sending
 */

import { useState, useCallback, useMemo } from 'react';
import type { Agent } from '@/lib/session/runtime-data';
import type { Session } from '@/lib/session/types';
import { useMentionFileSearch } from './use-mention-file-search';
import { detectMentionTrigger, mentionItems, pruneMentions } from '@/lib/session/mentions';
import { appendFileMention } from '@/lib/session/session-files';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface MentionItem {
  // 'skill' is produced by `useSkillMentions.ts` (the composer's separate
  // `#` trigger), not by this hook — the kind is widened here so
  // `MentionSuggestions.tsx` can render both @-mention and #-skill rows
  // through one component. `@` itself never produces a 'skill' item.
  kind: 'file' | 'agent' | 'session' | 'skill';
  label: string;
  value?: string;       // session ID for sessions, file path for files
  description?: string;
}

export interface TrackedMention {
  kind: 'file' | 'agent' | 'session';
  label: string;
  value?: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

// ─── Hook ────────────────────────────────────────────────────────────────────

interface UseMentionsOptions {
  agents: Agent[];
  sessions: Session[];
  currentSessionId?: string | null;
  sandboxUrl?: string;
}

export function useMentions({
  agents,
  sessions,
  currentSessionId,
  sandboxUrl,
}: UseMentionsOptions) {
  // ── State (mirrors frontend session-chat-input.tsx) ─────────────────────
  const [mentionQuery, setMentionQuery] = useState<{ query: string; triggerPos: number } | null>(null);
  const [mentions, setMentions] = useState<TrackedMention[]>([]);
  const { results: fileResults, loading: fileSearchLoading, clear: clearFileSearch } = useMentionFileSearch(mentionQuery, sandboxUrl);

  const isOpen = mentionQuery !== null;

  // ── Build mention items (matches frontend mentionItems useMemo) ─────────

  const items = useMemo(() => mentionItems(mentionQuery, agents, sessions, currentSessionId, fileResults), [mentionQuery, agents, sessions, currentSessionId, fileResults]);

  // ── Text change handler — @ detection (matches frontend handleInput) ────
  // On React Native we don't get cursor position from onChangeText.
  // The caller passes cursorPos (from onSelectionChange or text.length).

  const handleTextChange = useCallback(
    (text: string, cursorPos: number) => {
      const detected = detectMentionTrigger(text, cursorPos, mentions);
      setMentionQuery(detected);

      // Prune tracked mentions whose @label text was deleted
      setMentions((prev) => pruneMentions(text, prev));
    },
    [mentions],
  );

  // ── Select a mention from the popover ───────────────────────────────────

  const selectMention = useCallback(
    (item: MentionItem, text: string): string => {
      if (!mentionQuery) return text;

      const before = text.slice(0, mentionQuery.triggerPos);
      const after = text.slice(mentionQuery.triggerPos + 1 + mentionQuery.query.length);
      const inserted = `@${item.label} `;
      const newText = before + inserted + after;

      setMentions((prev) => [
        ...prev,
        {
          // This hook's own `mentionItems` never produces a 'skill' item —
          // that kind only exists on `MentionItem` so `MentionSuggestions`
          // can render `useSkillMentions.ts`'s rows too. Safe to narrow here.
          kind: item.kind as TrackedMention['kind'],
          label: item.label,
          ...(item.kind === 'session' ? { value: item.value } : {}),
        },
      ]);
      setMentionQuery(null);
      clearFileSearch();

      return newText;
    },
    [mentionQuery],
  );

  // ── Add a file mention from outside the popover (the Recent files sheet) ──

  const addFileMention = useCallback((label: string, text: string): string => {
    setMentions((prev) =>
      prev.some((m) => m.kind === 'file' && m.label === label)
        ? prev
        : [...prev, { kind: 'file', label }],
    );
    setMentionQuery(null);
    return appendFileMention(text, label);
  }, []);

  // ── Navigation ──────────────────────────────────────────────────────────

  const dismiss = useCallback(() => {
    setMentionQuery(null);
  }, []);

  // ── Reset on send ───────────────────────────────────────────────────────

  const reset = useCallback(() => {
    setMentions([]);
    setMentionQuery(null);
    clearFileSearch();
  }, []);

  return {
    isOpen,
    items,
    mentions,
    fileSearchLoading,
    handleTextChange,
    selectMention,
    addFileMention,
    dismiss,
    reset,
  };
}
