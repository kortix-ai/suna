'use client';

/**
 * Textarea with @-mention autocomplete.
 *
 * Typing @ opens a dropdown of team members (agents + the current user).
 * Typing after the @ filters by handle prefix. Arrow keys move the cursor,
 * Tab or Enter commits the selected candidate (inserting `@slug ` at the
 * cursor), and Escape closes the menu without inserting.
 *
 * The ref is forwarded to the underlying <textarea>, so callers that do
 * auto-resize or imperative focus still work unchanged.
 */

import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type TextareaHTMLAttributes,
} from 'react';
import { cn } from '@/lib/utils';
import {
  AgentAvatar,
  UserAvatar,
} from '@/components/kortix/agent-avatar';
import type { ProjectAgent } from '@/hooks/kortix/use-kortix-tickets';

type Candidate =
  | { type: 'user'; handle: string; avatarUrl: string | null }
  | { type: 'agent'; agent: ProjectAgent };

function candidateSlug(c: Candidate): string {
  return c.type === 'user' ? c.handle : c.agent.slug;
}

export interface MentionTextareaProps
  extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'onChange'> {
  value: string;
  onChange: (next: string) => void;
  agents: ProjectAgent[];
  userHandle: string;
  userAvatarUrl?: string | null;
}

export const MentionTextarea = forwardRef<HTMLTextAreaElement, MentionTextareaProps>(
  function MentionTextarea(
    { value, onChange, agents, userHandle, userAvatarUrl, onKeyDown, className, ...textareaProps },
    forwardedRef,
  ) {
    const innerRef = useRef<HTMLTextAreaElement>(null);
    useImperativeHandle(forwardedRef, () => innerRef.current!);

    // Null query = dropdown closed. Empty string = just typed @ with nothing after.
    const [query, setQuery] = useState<string | null>(null);
    const [anchor, setAnchor] = useState<{ start: number; end: number } | null>(null);
    const [selectedIdx, setSelectedIdx] = useState(0);

    const candidates = useMemo<Candidate[]>(() => {
      if (query === null) return [];
      const q = query.toLowerCase();
      const all: Candidate[] = [
        { type: 'user', handle: userHandle, avatarUrl: userAvatarUrl ?? null },
        ...agents.map<Candidate>((a) => ({ type: 'agent', agent: a })),
      ];
      return all.filter((c) => candidateSlug(c).toLowerCase().includes(q)).slice(0, 8);
    }, [query, agents, userHandle, userAvatarUrl]);

    const detectTrigger = useCallback((text: string, caret: number) => {
      // Walk backwards from the caret across slug-safe characters until we hit
      // the '@' or something that aborts the match.
      let i = caret - 1;
      while (i >= 0 && /[a-z0-9_.-]/i.test(text[i])) i--;
      if (i < 0 || text[i] !== '@') {
        setQuery(null); setAnchor(null); return;
      }
      // '@' must be at line start or preceded by whitespace to count as a
      // mention — otherwise it's an email or a literal.
      const before = text[i - 1];
      if (i > 0 && before !== undefined && !/\s/.test(before)) {
        setQuery(null); setAnchor(null); return;
      }
      setAnchor({ start: i, end: caret });
      setQuery(text.slice(i + 1, caret));
      setSelectedIdx(0);
    }, []);

    const close = useCallback(() => {
      setQuery(null);
      setAnchor(null);
    }, []);

    const commit = useCallback((idx: number) => {
      const el = innerRef.current;
      if (!anchor || idx < 0 || idx >= candidates.length || !el) return;
      const slug = candidateSlug(candidates[idx]);
      const next = value.slice(0, anchor.start) + '@' + slug + ' ' + value.slice(anchor.end);
      onChange(next);
      const newCaret = anchor.start + slug.length + 2; // '@' + slug + ' '
      requestAnimationFrame(() => {
        el.focus();
        try { el.setSelectionRange(newCaret, newCaret); } catch {}
      });
      close();
    }, [anchor, candidates, value, onChange, close]);

    const handleChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
      onChange(e.target.value);
      detectTrigger(e.target.value, e.target.selectionStart ?? e.target.value.length);
    };

    const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (query !== null && candidates.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setSelectedIdx((i) => (i + 1) % candidates.length);
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          setSelectedIdx((i) => (i - 1 + candidates.length) % candidates.length);
          return;
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault();
          commit(selectedIdx);
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          close();
          return;
        }
      }
      // Re-detect after some navigation keys so moving the caret past an
      // existing mention updates the popup.
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') {
        setTimeout(() => {
          const el = innerRef.current;
          if (el) detectTrigger(el.value, el.selectionStart ?? 0);
        }, 0);
      }
      onKeyDown?.(e);
    };

    const handleSelect = () => {
      const el = innerRef.current;
      if (el) detectTrigger(el.value, el.selectionStart ?? 0);
    };

    const open = query !== null && candidates.length > 0;

    return (
      <div className="relative">
        <textarea
          {...textareaProps}
          ref={innerRef}
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onSelect={handleSelect}
          onBlur={(e) => {
            // Let clicks inside the dropdown (mousedown prevents blur) still
            // commit before we close.
            textareaProps.onBlur?.(e);
            setTimeout(close, 80);
          }}
          className={className}
        />
        {open && (
          <div
            role="listbox"
            className="absolute left-0 top-full mt-1 min-w-[220px] max-w-[280px] rounded-xl border border-border/60 bg-card shadow-xl z-[10001] overflow-hidden py-1"
            onMouseDown={(e) => e.preventDefault()}
          >
            <div className="px-3 py-1.5 text-[10px] uppercase tracking-[0.08em] text-muted-foreground/55 font-semibold">
              Tag team member
            </div>
            {candidates.map((c, i) => {
              const slug = candidateSlug(c);
              const active = i === selectedIdx;
              return (
                <button
                  key={`${c.type}:${slug}`}
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setSelectedIdx(i)}
                  onClick={() => commit(i)}
                  className={cn(
                    'w-full flex items-center gap-2 px-3 py-1.5 text-left cursor-pointer transition-colors',
                    active ? 'bg-muted/50' : 'hover:bg-muted/30',
                  )}
                  role="option"
                  aria-selected={active}
                >
                  {c.type === 'agent' ? (
                    <AgentAvatar hue={c.agent.color_hue} icon={c.agent.icon} slug={c.agent.slug} name={c.agent.name} size="sm" />
                  ) : (
                    <UserAvatar handle={c.handle} avatarUrl={c.avatarUrl} size="sm" />
                  )}
                  <span className="flex-1 min-w-0 truncate">
                    <span className="text-[12.5px] font-medium text-foreground">@{slug}</span>
                    {c.type === 'agent' && c.agent.name && c.agent.name !== slug && (
                      <span className="text-[11px] text-muted-foreground/55 ml-1.5">{c.agent.name}</span>
                    )}
                  </span>
                  {c.type === 'user' && (
                    <span className="text-[10px] text-muted-foreground/40">you</span>
                  )}
                </button>
              );
            })}
            <div className="px-3 py-1.5 text-[10px] text-muted-foreground/40 border-t border-border/30 mt-1">
              ↑↓ to navigate · ↵ to insert · esc to dismiss
            </div>
          </div>
        )}
      </div>
    );
  },
);
