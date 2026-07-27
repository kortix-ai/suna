'use client';

/**
 * How much of the transcript is showing — the one knob behind "all complexity
 * optionable".
 *
 * The product decision this encodes: variants A ("Grouped") and C ("Narrative")
 * are not competing designs. They are the two ends of ONE control. C is the
 * resting state — the ask, the answer, the deliverable. A is what the same turn
 * looks like when the reader asks for the full history. Nothing is a different
 * screen, a different route, or a different mode you have to go find; it is one
 * toggle that re-renders the transcript in place.
 *
 * `'narrative'` is the default for everyone, including existing users. Someone
 * who wants the log has to ask once, and then never again — the choice
 * persists.
 */

import { Button } from '@/components/ui/button';
import Hint from '@/components/ui/hint';
import { Kbd } from '@/components/ui/kbd';
import { cn } from '@/lib/utils';
import { ListTree, Text } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

export type ChatDetail = 'narrative' | 'full';

/** Maps the reader-facing knob onto the grouping model's density. */
export function densityForDetail(detail: ChatDetail): 'simple' | 'detailed' {
  return detail === 'full' ? 'detailed' : 'simple';
}

interface ChatDetailValue {
  detail: ChatDetail;
  setDetail: (next: ChatDetail) => void;
  toggle: () => void;
}

const ChatDetailContext = createContext<ChatDetailValue | null>(null);

const STORAGE_KEY = 'kortix.chat-detail';

/**
 * Provider. Reads the persisted choice on mount rather than during render so
 * server and client agree on the first paint — a localStorage read in the
 * initializer hydrates as a mismatch and flashes the wrong transcript.
 */
export function ChatDetailProvider({
  children,
  initial = 'narrative',
}: {
  children: React.ReactNode;
  initial?: ChatDetail;
}) {
  const [detail, setDetailState] = useState<ChatDetail>(initial);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (stored === 'narrative' || stored === 'full') setDetailState(stored);
    } catch {
      // Private mode / storage disabled — the default is a fine answer.
    }
  }, []);

  const setDetail = useCallback((next: ChatDetail) => {
    setDetailState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Non-fatal: the session keeps the choice, it just won't outlive the tab.
    }
  }, []);

  const toggle = useCallback(
    () => setDetail(detail === 'full' ? 'narrative' : 'full'),
    [detail, setDetail],
  );

  // ⌘/ — cheap to reach mid-read, and it is the shortcut a power user will try
  // for "show me more". Ignored while typing so it never eats a composer key.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key !== '/') return;
      const el = document.activeElement;
      const typing =
        el instanceof HTMLTextAreaElement ||
        el instanceof HTMLInputElement ||
        (el instanceof HTMLElement && el.isContentEditable);
      if (typing) return;
      e.preventDefault();
      toggle();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggle]);

  const value = useMemo(() => ({ detail, setDetail, toggle }), [detail, setDetail, toggle]);
  return <ChatDetailContext.Provider value={value}>{children}</ChatDetailContext.Provider>;
}

/**
 * Reading the knob. Safe outside a provider — an un-wrapped transcript is
 * simply always narrative, which is the correct default rather than a crash.
 */
export function useChatDetail(): ChatDetailValue {
  const ctx = useContext(ChatDetailContext);
  const fallbackSet = useCallback(() => {}, []);
  const fallback = useMemo(
    () => ({ detail: 'narrative' as ChatDetail, setDetail: fallbackSet, toggle: fallbackSet }),
    [fallbackSet],
  );
  return ctx ?? fallback;
}

/**
 * The control itself.
 *
 * Deliberately a text button and not a segmented switch: at rest it should read
 * as an offer ("Show full history"), not as a setting the reader has to have an
 * opinion about before they can start reading. It states what it will DO, not
 * which mode you are in — the transcript already tells you that.
 */
export function ChatDetailToggle({ className }: { className?: string }) {
  const { detail, toggle } = useChatDetail();
  const showingFull = detail === 'full';

  return (
    <Hint
      side="bottom"
      sideOffset={4}
      delayDuration={400}
      label={
        <span className="flex items-center gap-1.5">
          {showingFull ? 'Back to the summary' : 'Every step, in order'}
          <Kbd className="font-mono">⌘/</Kbd>
        </span>
      }
    >
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={toggle}
        aria-pressed={showingFull}
        className={cn(
          'text-muted-foreground/70 hover:text-foreground h-7 gap-1.5 px-2 text-xs',
          className,
        )}
      >
        {showingFull ? <Text className="size-3.5" /> : <ListTree className="size-3.5" />}
        {showingFull ? 'Hide full history' : 'Show full history'}
      </Button>
    </Hint>
  );
}
