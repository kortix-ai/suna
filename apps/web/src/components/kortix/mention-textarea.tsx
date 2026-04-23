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
  type UIEvent,
} from 'react';
import { cn } from '@/lib/utils';
import {
  AgentAvatar,
  UserAvatar,
} from '@/components/kortix/agent-avatar';
import type { ProjectAgent } from '@/hooks/kortix/use-kortix-tickets';

// ─── Tokenizer ────────────────────────────────────────────────────────────
//
// Produces character-exact runs so the overlay can be rendered without
// changing any positions. Every character of the input appears in exactly
// one run — that's how the overlay stays aligned with the textarea under
// it when the content wraps.
//
// Recognised patterns (flat, no nesting):
//   @slug         when the slug matches a known team member
//   **bold**      markers dimmed, inner bold
//   *italic*      markers dimmed, inner italic
//   `code`        markers dimmed, inner monospace on muted bg
//   ~~strike~~    markers dimmed, inner line-through
//   # heading     leading hashes + space colored (can't change font-size
//                 without breaking wrap alignment)
//   - / * bullet  leading marker colored
//   [label](url)  markers dimmed, label underlined + primary
//
// Email-style "foo@bar" stays plain because mentions require whitespace or
// line start before the @.

interface Run { text: string; className?: string }

const CLS = {
  mention:     'font-semibold text-primary rounded-sm px-0.5 bg-primary/10',
  mentionSelf: 'font-bold text-amber-400 rounded-sm px-0.5 bg-amber-500/15',
  bold:        'font-semibold',
  italic:      'italic',
  code:        'bg-muted/50 rounded-sm px-0.5 font-mono text-foreground',
  strike:      'line-through decoration-foreground/60',
  link:        'text-primary underline underline-offset-2 decoration-primary/40',
  dim:         'text-muted-foreground/40',
  heading:     'text-primary/70 font-bold',
  bullet:      'text-primary/70 font-semibold',
} as const;

function combine(a?: string, b?: string): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return `${a} ${b}`;
}

export function tokenizeMarkdown(text: string, knownSlugs: Set<string>, selfHandle?: string): Run[] {
  return tokenize(text, knownSlugs, selfHandle);
}

function tokenize(text: string, knownSlugs: Set<string>, selfHandle?: string): Run[] {
  const runs: Run[] = [];
  const push = (seg: string, className?: string) => {
    if (!seg) return;
    const last = runs[runs.length - 1];
    if (last && last.className === className) last.text += seg;
    else runs.push({ text: seg, className });
  };

  let i = 0;
  let atLineStart = true;
  const N = text.length;

  while (i < N) {
    const ch = text[i];

    // Newlines — reset line-start flag.
    if (ch === '\n') {
      push('\n');
      atLineStart = true;
      i++;
      continue;
    }

    // Heading: ^#{1,6} + space (doesn't resize so wrap matches textarea).
    if (atLineStart && ch === '#') {
      let level = 0;
      let j = i;
      while (j < N && text[j] === '#' && level < 6) { level++; j++; }
      if (j < N && text[j] === ' ') {
        push(text.slice(i, j + 1), CLS.heading);
        i = j + 1;
        atLineStart = false;
        continue;
      }
    }
    // Bullet: ^(\s*)([-*+]|\d+\.) + space
    if (atLineStart) {
      const bm = /^(\s*)(-|\*|\+|\d+\.) /.exec(text.slice(i));
      if (bm) {
        push(bm[1]);
        push(bm[2] + ' ', CLS.bullet);
        i += bm[0].length;
        atLineStart = false;
        continue;
      }
    }
    atLineStart = false;

    // Inline code `...`
    if (ch === '`') {
      const end = text.indexOf('`', i + 1);
      if (end > i && !text.slice(i + 1, end).includes('\n')) {
        push('`', CLS.dim);
        push(text.slice(i + 1, end), CLS.code);
        push('`', CLS.dim);
        i = end + 1;
        continue;
      }
    }

    // Bold **...**
    if (ch === '*' && text[i + 1] === '*') {
      const end = text.indexOf('**', i + 2);
      if (end > i + 1 && !text.slice(i + 2, end).includes('\n')) {
        push('**', CLS.dim);
        push(text.slice(i + 2, end), CLS.bold);
        push('**', CLS.dim);
        i = end + 2;
        continue;
      }
    }

    // Italic *...* (only when not followed by another * — which would be
    // bold and would already have matched).
    if (ch === '*' && text[i + 1] !== '*') {
      const end = text.indexOf('*', i + 1);
      if (end > i && !text.slice(i + 1, end).includes('\n') && text[end + 1] !== '*') {
        push('*', CLS.dim);
        push(text.slice(i + 1, end), CLS.italic);
        push('*', CLS.dim);
        i = end + 1;
        continue;
      }
    }

    // Strike ~~...~~
    if (ch === '~' && text[i + 1] === '~') {
      const end = text.indexOf('~~', i + 2);
      if (end > i + 1 && !text.slice(i + 2, end).includes('\n')) {
        push('~~', CLS.dim);
        push(text.slice(i + 2, end), CLS.strike);
        push('~~', CLS.dim);
        i = end + 2;
        continue;
      }
    }

    // Link [label](url)
    if (ch === '[') {
      const close = text.indexOf(']', i + 1);
      if (close > i && text[close + 1] === '(' && !text.slice(i + 1, close).includes('\n')) {
        const paren = text.indexOf(')', close + 2);
        if (paren > close && !text.slice(close + 2, paren).includes('\n')) {
          push('[', CLS.dim);
          push(text.slice(i + 1, close), CLS.link);
          push('](', CLS.dim);
          push(text.slice(close + 2, paren), combine(CLS.dim, CLS.link));
          push(')', CLS.dim);
          i = paren + 1;
          continue;
        }
      }
    }

    // Mention: @slug, preceded by whitespace or line start (already true if i === 0 or last pushed ended with whitespace). Re-check against source.
    if (ch === '@' && (i === 0 || /\s/.test(text[i - 1]))) {
      const m = /^@[a-z0-9_.-]+/i.exec(text.slice(i));
      if (m) {
        const slug = m[0].slice(1).toLowerCase();
        if (knownSlugs.has(slug)) {
          const cls = selfHandle && slug === selfHandle.toLowerCase() ? CLS.mentionSelf : CLS.mention;
          push(m[0], cls);
          i += m[0].length;
          continue;
        }
      }
    }

    // Ordinary character — coalesced into the previous run.
    push(text[i]);
    i++;
  }

  return runs;
}

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

    // Guard against undefined leaking in — we always drive the textarea with
    // a string so it's controlled from first render.
    value = value ?? '';

    // Null query = dropdown closed. Empty string = just typed @ with nothing after.
    const [query, setQuery] = useState<string | null>(null);
    const [anchor, setAnchor] = useState<{ start: number; end: number } | null>(null);
    const [selectedIdx, setSelectedIdx] = useState(0);
    // Overlay scroll is kept in sync with the textarea so highlighted tokens
    // track the visible viewport when the content overflows.
    const [scrollTop, setScrollTop] = useState(0);

    // Tokenize once per change to highlight recognised @mentions inline.
    const knownSlugs = useMemo(() => {
      const s = new Set<string>();
      s.add(userHandle.toLowerCase());
      for (const a of agents) s.add(a.slug.toLowerCase());
      return s;
    }, [agents, userHandle]);
    const tokens = useMemo(() => tokenize(value, knownSlugs, userHandle), [value, knownSlugs, userHandle]);

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

    const handleScroll = (e: UIEvent<HTMLTextAreaElement>) => setScrollTop(e.currentTarget.scrollTop);

    // Shared style surface so the overlay's wrapping EXACTLY matches the
    // textarea's, down to padding + font metrics. The textarea carries the
    // caller's `className`; the overlay inherits it and overrides colors so
    // it's the visible layer. The textarea itself renders transparent text
    // (the caret stays via `caret-foreground`).
    const overlayCls = cn(
      className,
      'absolute inset-0 pointer-events-none overflow-hidden whitespace-pre-wrap break-words text-foreground/90',
      'select-none',
    );
    const textareaCls = cn(
      className,
      'relative bg-transparent text-transparent caret-foreground',
      'selection:bg-primary/30 selection:text-transparent',
    );

    return (
      <div className="relative">
        {/* Syntax overlay — renders under the textarea and paints styled
            spans over every recognised markdown construct: @mentions, bold,
            italic, code, strike, links, headings, bullets. Transforms with
            the textarea's scrollTop so long content stays in sync. */}
        <div className={overlayCls} aria-hidden>
          <div style={{ transform: `translateY(${-scrollTop}px)` }}>
            {tokens.length === 0 ? (
              <span>{'\u200B'}</span>
            ) : tokens.map((t, i) => (
              <span key={i} className={t.className}>{t.text}</span>
            ))}
            {/* Keep trailing newline visible so wrap calc doesn't collapse */}
            {value.endsWith('\n') && <span>{'\u200B'}</span>}
          </div>
        </div>
        <textarea
          {...textareaProps}
          ref={innerRef}
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onScroll={handleScroll}
          onSelect={handleSelect}
          onBlur={(e) => {
            // Let clicks inside the dropdown (mousedown prevents blur) still
            // commit before we close.
            textareaProps.onBlur?.(e);
            setTimeout(close, 80);
          }}
          className={textareaCls}
          spellCheck={textareaProps.spellCheck ?? false}
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
