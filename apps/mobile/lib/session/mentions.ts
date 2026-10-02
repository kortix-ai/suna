import type { Agent } from '@/lib/session/runtime-data';
import type { Session } from '@/lib/session/types';
import type { MentionItem, TrackedMention } from '@/components/session/useMentions';

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

export function mentionItems(mentionQuery: { query: string } | null, agents: Agent[], sessions: Session[], currentSessionId: string | null | undefined, fileResults: string[]): MentionItem[] {
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
          return diffs.some((d) => (d.file ?? '').toLowerCase().includes(q));
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
}

export function detectMentionTrigger(text: string, cursorPos: number, mentions: TrackedMention[]): { query: string; triggerPos: number } | null {
      const pos = Math.min(cursorPos, text.length);

      let mentionQuery: { query: string; triggerPos: number } | null = null;
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
              mentionQuery = { query: q, triggerPos: i };
            }
          }
          break;
        }
      }

      return mentionQuery;
}

/** Returns `mentions` itself when nothing is pruned, so a keystroke keeps the state's identity. */
export function pruneMentions(text: string, mentions: TrackedMention[]): TrackedMention[] {
  const kept = mentions.filter((m) => text.includes(`@${m.label}`));
  return kept.length === mentions.length ? mentions : kept;
}
