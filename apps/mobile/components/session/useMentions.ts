/**
 * useMentions — hook for @-mention detection, querying, and tracking.
 *
 * Mirrors the frontend's session-chat-input.tsx mention system:
 * - Detects "@" by walking backwards from cursor position
 * - Provides filtered suggestions for agents, sessions, and files
 * - Tracks inserted mentions for sending
 */

import { useState, useCallback, useRef, useMemo, useEffect } from 'react';
import type { Agent } from '@/lib/opencode/hooks/use-opencode-data';
import type { Session } from '@/lib/platform/types';
import { searchFiles, rankFile } from '@/lib/utils/file-search';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface MentionItem {
  kind: 'file' | 'agent' | 'session';
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

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return `${Math.floor(days / 7)}w ago`;
}

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
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentions, setMentions] = useState<TrackedMention[]>([]);
  const [fileResults, setFileResults] = useState<string[]>([]);
  const [fileSearchLoading, setFileSearchLoading] = useState(false);
  const fileSearchTimer = useRef<ReturnType<typeof setTimeout>>();
  const fileSearchSeq = useRef(0);
  const fileResultsCache = useRef<Set<string>>(new Set());

  const isOpen = mentionQuery !== null;
  const query = mentionQuery?.query ?? '';

  // ── Debounced file search (matches frontend useEffect) ──────────────────

  useEffect(() => {
    clearTimeout(fileSearchTimer.current);

    if (!mentionQuery || !sandboxUrl) {
      setFileResults([]);
      setFileSearchLoading(false);
      fileResultsCache.current.clear();
      return;
    }

    // Immediately apply cached results that match the new query
    const q = mentionQuery.query.toLowerCase();
    if (fileResultsCache.current.size > 0) {
      const cachedMatches = Array.from(fileResultsCache.current)
        .filter((f) => q.length === 0 || f.toLowerCase().includes(q))
        .sort((a, b) => rankFile(a, q) - rankFile(b, q));
      if (cachedMatches.length > 0) {
        setFileResults(cachedMatches.slice(0, 20));
      }
    }

    setFileSearchLoading(true);
    const seq = ++fileSearchSeq.current;
    const currentQuery = mentionQuery.query;

    fileSearchTimer.current = setTimeout(async () => {
      try {
        const results = await searchFiles(sandboxUrl, currentQuery);
        for (const r of results) fileResultsCache.current.add(r);
        if (seq === fileSearchSeq.current) {
          const ql = currentQuery.toLowerCase();
          const cachedMatches = Array.from(fileResultsCache.current)
            .filter((f) => ql.length === 0 || f.toLowerCase().includes(ql));
          const merged = new Set([...results, ...cachedMatches]);
          setFileResults(
            Array.from(merged)
              .sort((a, b) => rankFile(a, ql) - rankFile(b, ql))
              .slice(0, 20),
          );
          setFileSearchLoading(false);
        }
      } catch {
        if (seq === fileSearchSeq.current) {
          const ql = currentQuery.toLowerCase();
          const cachedMatches = Array.from(fileResultsCache.current)
            .filter((f) => ql.length === 0 || f.toLowerCase().includes(ql));
          setFileResults(cachedMatches.slice(0, 20));
          setFileSearchLoading(false);
        }
      }
    }, 150);

    return () => clearTimeout(fileSearchTimer.current);
  }, [mentionQuery?.query, sandboxUrl]);

  // ── Build mention items (matches frontend mentionItems useMemo) ─────────

  const items = useMemo<MentionItem[]>(() => {
    if (!mentionQuery) return [];
    const q = mentionQuery.query.toLowerCase();

    // Agents
    const agentItems: MentionItem[] = agents
      .filter((a) => !a.hidden && a.name.toLowerCase().includes(q))
      .slice(0, 5)
      .map((a) => ({ kind: 'agent' as const, label: a.name, value: a.name }));

    // Sessions (exclude current, children, archived)
    const sessionItems: MentionItem[] = sessions
      .filter((s) => {
        if (s.id === currentSessionId) return false;
        if (s.parentID) return false;
        if (s.time.archived) return false;
        const title = (s.title || '').toLowerCase();
        if (title.includes(q)) return true;
        const diffs = s.summary?.diffs;
        if (Array.isArray(diffs)) {
          return diffs.some((d: any) => ((d.file || d.path || '') as string).toLowerCase().includes(q));
        }
        return false;
      })
      .slice(0, 5)
      .map((s) => {
        const ago = timeAgo(s.time.updated);
        const files = s.summary?.files ?? 0;
        const desc = files > 0 ? `${ago} - ${files} file${files > 1 ? 's' : ''} changed` : ago;
        return { kind: 'session' as const, label: s.title || s.id.slice(0, 8), value: s.id, description: desc };
      });

    // Files
    const filteredFiles = q.length > 0
      ? fileResults.filter((f) => f.toLowerCase().includes(q))
      : fileResults;
    const fileItems: MentionItem[] = filteredFiles.map((f) => ({
      kind: 'file' as const,
      label: f,
      value: f,
    }));

    return [...agentItems, ...sessionItems, ...fileItems];
  }, [mentionQuery, agents, sessions, currentSessionId, fileResults]);

  // Clamp index when items change
  useEffect(() => {
    if (items.length > 0) {
      setMentionIndex((i) => Math.min(i, items.length - 1));
    }
  }, [items.length]);

  // ── Text change handler — @ detection (matches frontend handleInput) ────
  // On React Native we don't get cursor position from onChangeText.
  // The caller passes cursorPos (from onSelectionChange or text.length).

  const handleTextChange = useCallback(
    (text: string, cursorPos: number) => {
      const pos = Math.min(cursorPos, text.length);

      let mentionDetected = false;
      for (let i = pos - 1; i >= 0; i--) {
        const ch = text[i];
        if (ch === ' ' || ch === '\n') break;
        if (ch === '@') {
          const charBefore = i > 0 ? text[i - 1] : ' ';
          if (charBefore === ' ' || charBefore === '\n' || i === 0) {
            const q = text.slice(i + 1, pos);
            // Don't re-trigger for already-tracked mentions (exact match only)
            const isAlreadyTracked = mentions.some((m) => m.label === q);
            if (!isAlreadyTracked) {
              setMentionQuery({ query: q, triggerPos: i });
              setMentionIndex(0);
              mentionDetected = true;
            }
          }
          break;
        }
      }
      if (!mentionDetected) {
        setMentionQuery(null);
      }

      // Prune tracked mentions whose @label text was deleted
      setMentions((prev) => prev.filter((m) => text.includes(`@${m.label}`)));
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
          kind: item.kind,
          label: item.label,
          ...(item.kind === 'session' ? { value: item.value } : {}),
        },
      ]);
      setMentionQuery(null);
      setMentionIndex(0);
      setFileResults([]);
      fileResultsCache.current.clear();

      return newText;
    },
    [mentionQuery],
  );

  // ── Navigation ──────────────────────────────────────────────────────────

  const moveUp = useCallback(() => {
    setMentionIndex((i) => Math.max(0, i - 1));
  }, []);

  const moveDown = useCallback(() => {
    setMentionIndex((i) => Math.min(items.length - 1, i + 1));
  }, [items.length]);

  const dismiss = useCallback(() => {
    setMentionQuery(null);
    setMentionIndex(0);
  }, []);

  // ── Reset on send ───────────────────────────────────────────────────────

  const reset = useCallback(() => {
    setMentions([]);
    setMentionQuery(null);
    setMentionIndex(0);
    setFileResults([]);
    fileResultsCache.current.clear();
  }, []);

  return {
    isOpen,
    query,
    items,
    selectedIndex: mentionIndex,
    mentions,
    fileSearchLoading,
    handleTextChange,
    selectMention,
    moveUp,
    moveDown,
    dismiss,
    reset,
  };
}
