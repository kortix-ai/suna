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
 *
 * Deliberately a module-level store rather than React context. The toggle lives
 * in the session header, which mounts from two different shells
 * (`session-chat` and `instant-session-shell`); a context provider inside one
 * of them left the other rendering a menu item that silently did nothing and
 * mislabelled the current state. A store has no placement to get wrong.
 */

import { Button } from '@/components/ui/button';
import Hint from '@/components/ui/hint';
import { Kbd } from '@/components/ui/kbd';
import { cn } from '@/lib/utils';
import { ListTree, Text } from 'lucide-react';
import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';

export type ChatDetail = 'narrative' | 'full';

/** What a reader who has never touched the toggle sees. */
export const DEFAULT_CHAT_DETAIL: ChatDetail = 'narrative';

/** Maps the reader-facing knob onto the grouping model's density. */
export function densityForDetail(detail: ChatDetail): 'simple' | 'detailed' {
  return detail === 'full' ? 'detailed' : 'simple';
}

/** The other end of the toggle. Pure, so the label logic can be tested. */
export function oppositeDetail(detail: ChatDetail): ChatDetail {
  return detail === 'full' ? 'narrative' : 'full';
}

const STORAGE_KEY = 'kortix.chat-detail';

/** Anything that isn't one of the two known values is "no stored choice". */
export function parseChatDetail(raw: string | null | undefined): ChatDetail | null {
  return raw === 'narrative' || raw === 'full' ? raw : null;
}

// ── The store ────────────────────────────────────────────────────────────────
// Starts at the default on both server and client so the first client render
// matches the SSR markup exactly. The persisted choice is applied in an effect
// (see `ensureClientInit`), one tick later — a localStorage read during render
// hydrates as a mismatch and flashes the wrong transcript.

let currentDetail: ChatDetail = DEFAULT_CHAT_DETAIL;
const listeners = new Set<() => void>();
let clientInitialized = false;

function emit() {
  for (const listener of [...listeners]) listener();
}

function subscribe(onStoreChange: () => void) {
  listeners.add(onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
  };
}

const getSnapshot = () => currentDetail;
const getServerSnapshot = () => DEFAULT_CHAT_DETAIL;

function readStoredDetail(): ChatDetail | null {
  try {
    return parseChatDetail(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    // Private mode / storage disabled / no DOM — the default is a fine answer.
    return null;
  }
}

/** Read the knob outside React. */
export function getChatDetail(): ChatDetail {
  return currentDetail;
}

/** Set the knob and remember it. Exported so non-React callers can drive it. */
export function setChatDetail(next: ChatDetail) {
  try {
    // Written even when the value is unchanged, so choosing the current default
    // explicitly still survives a future change to `DEFAULT_CHAT_DETAIL`.
    window.localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // Non-fatal: the tab keeps the choice, it just won't outlive the tab.
  }
  if (next === currentDetail) return;
  currentDetail = next;
  emit();
}

function applyStoredDetail() {
  const stored = readStoredDetail();
  if (!stored || stored === currentDetail) return;
  currentDetail = stored;
  emit();
}

/**
 * Runs once per page load, from the first mounted consumer: hydrate the
 * persisted choice, keep other tabs in sync, and install the ⌘/ shortcut.
 *
 * The shortcut is global rather than per-consumer because the transcript, the
 * header menu, and the variant demo all read the same knob — one listener for
 * the app is the whole requirement, and N mounted turns must not install N.
 */
function ensureClientInit() {
  if (clientInitialized || typeof window === 'undefined') return;
  clientInitialized = true;

  applyStoredDetail();

  // Another tab changed the preference — follow it rather than drift.
  window.addEventListener('storage', (e) => {
    if (e.key !== null && e.key !== STORAGE_KEY) return;
    applyStoredDetail();
  });

  // ⌘/ — cheap to reach mid-read, and it is the shortcut a power user will try
  // for "show me more". Ignored while typing so it never eats a composer key.
  window.addEventListener('keydown', (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.key !== '/') return;
    const el = document.activeElement;
    const typing =
      el instanceof HTMLTextAreaElement ||
      el instanceof HTMLInputElement ||
      (el instanceof HTMLElement && el.isContentEditable);
    if (typing) return;
    e.preventDefault();
    setChatDetail(oppositeDetail(currentDetail));
  });
}

interface ChatDetailValue {
  detail: ChatDetail;
  setDetail: (next: ChatDetail) => void;
  toggle: () => void;
}

/**
 * Reading the knob. Works anywhere in the tree — there is no provider to be
 * outside of, which is what makes the header menu correct from both shells.
 */
export function useChatDetail(): ChatDetailValue {
  const detail = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  useEffect(() => {
    ensureClientInit();
  }, []);

  const toggle = useCallback(() => setChatDetail(oppositeDetail(currentDetail)), []);

  return useMemo(() => ({ detail, setDetail: setChatDetail, toggle }), [detail, toggle]);
}

/**
 * The control itself.
 *
 * Deliberately a text button and not a segmented switch: it states what it will
 * DO, not which mode you are in — the transcript already tells you that. At
 * rest (the folded reading) that is "Show full history", the offer to go
 * deeper; the reader never has to have an opinion before they can start
 * reading.
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
