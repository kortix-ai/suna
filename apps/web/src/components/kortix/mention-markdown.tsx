'use client';

/**
 * Lightweight renderer that reuses the MentionTextarea tokenizer to paint
 * the SAME highlighted spans the composer draws — bold / italic / code /
 * mentions (with self-mentions in amber) — but read-only and without an
 * editing surface behind it.
 *
 * Used for comment bodies where UnifiedMarkdown would render the text but
 * swallow @-mention styling. Covers the inline subset that comments need
 * (bold, italic, code, strike, links, mentions, heading/bullet markers).
 * Multi-line blocks (code fences, tables) aren't handled — if that's
 * needed later, wrap UnifiedMarkdown and post-process via a rehype plugin.
 */

import { useMemo } from 'react';
import { cn } from '@/lib/utils';
import { tokenizeMarkdown } from '@/components/kortix/mention-textarea';
import type { ProjectAgent } from '@/hooks/kortix/use-kortix-tickets';

interface Props {
  content: string;
  agents: ProjectAgent[];
  userHandle: string;
  className?: string;
}

export function MentionMarkdown({ content, agents, userHandle, className }: Props) {
  const knownSlugs = useMemo(() => {
    const s = new Set<string>();
    s.add(userHandle.toLowerCase());
    for (const a of agents) s.add(a.slug.toLowerCase());
    return s;
  }, [agents, userHandle]);
  const runs = useMemo(
    () => tokenizeMarkdown(content, knownSlugs, userHandle),
    [content, knownSlugs, userHandle],
  );

  return (
    <div className={cn('whitespace-pre-wrap break-words', className)}>
      {runs.map((r, i) => (
        <span key={i} className={r.className}>{r.text}</span>
      ))}
    </div>
  );
}
