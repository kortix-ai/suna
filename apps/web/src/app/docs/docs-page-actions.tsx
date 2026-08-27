'use client';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ChatGPT } from '@/features/icon/icons/chat-gpt';
import { Claude } from '@/features/icon/icons/claude';
import { Copy } from '@/features/icon/icons/copy';
import { Cursor } from '@/features/icon/icons/cursor';
import { Github } from '@/features/icon/icons/github';
import { Kortix } from '@/features/icon/icons/kortix';
import { cn } from '@/lib/utils';
// `docs-page-actions.tsx` is 'use client', so — unlike page.tsx/layout.tsx —
// it is the one place in the docs surface allowed to dot into the client
// `Icon` namespace directly. That is also why `CheckIcon` comes from the main
// entry and not `@/lib/icons/ssr`: the SSR module hard-binds the weight for
// components that cannot read context, and using it here would cut the icon
// off from `IconProvider`.
import {
  ArrowSquareOutIcon,
  CaretDownIcon,
  CheckIcon,
  MarkdownLogoIcon,
} from '@phosphor-icons/react';
import { AnimatePresence, m } from 'motion/react';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { createMarkdownSource } from './markdown-source';

type OpenAction = {
  key: string;
  label: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
};

type CopyState = 'idle' | 'copying' | 'copied';

const COPIED_RESET_MS = 2000;

export function DocsPageActions({
  markdownPath,
  githubUrl,
  pageUrl,
  className,
}: {
  markdownPath: string;
  githubUrl: string;
  pageUrl: string;
  /** Spacing is the caller's business — this component owns the row, not its margins. */
  className?: string;
}) {
  const prompt = `Read ${pageUrl} so I can ask questions about it.`;
  const encodedPrompt = encodeURIComponent(prompt);

  const openActions: OpenAction[] = [
    { key: 'github', label: 'Open in GitHub', href: githubUrl, icon: Github },
    { key: 'markdown', label: 'View as Markdown', href: markdownPath, icon: MarkdownLogoIcon },
    {
      key: 'kortix',
      label: 'Open in Kortix',
      href: `/projects/start?q=${encodedPrompt}`,
      icon: Kortix,
    },
    {
      key: 'chatgpt',
      label: 'Open in ChatGPT',
      href: `https://chatgpt.com/?q=${encodedPrompt}`,
      icon: ChatGPT,
    },
    {
      key: 'claude',
      label: 'Open in Claude',
      href: `https://claude.ai/new?q=${encodedPrompt}`,
      icon: Claude,
    },
    {
      key: 'cursor',
      label: 'Open in Cursor',
      href: `cursor://anysphere.cursor-deeplink/prompt?text=${encodedPrompt}`,
      icon: Cursor,
    },
  ];

  // One row, two ends: the page's own actions (copy / open) sit under the
  // description where the reader's eye already is, and the contributor action
  // (edit) is pushed to the far edge so it never competes with them.
  // On narrow viewports labels shorten and the row may wrap — full labels
  // return at `sm` and up.
  return (
    <div className={cn('flex flex-wrap items-center justify-between gap-x-3 gap-y-2', className)}>
      <div className="flex min-w-0 items-center gap-1.5">
        <CopyMarkdownButton markdownPath={markdownPath} />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="shrink-0 gap-1.5">
              Open
              <CaretDownIcon className="size-3" />
            </Button>
          </DropdownMenuTrigger>
          {/* Left-aligned: the trigger now sits at the row's left edge, so
              anchoring the menu to its end would open it away from the button. */}
          <DropdownMenuContent align="start">
            {openActions.map(({ key, label, href, icon: ItemIcon }) => (
              <DropdownMenuItem key={key} asChild className="group">
                <Link href={href} target="_blank" rel="noreferrer noopener">
                  <ItemIcon className="size-3.5" />
                  <span className="min-w-0 flex-1">{label}</span>
                  <ArrowSquareOutIcon className="text-muted-foreground size-3.5 opacity-0 transition-opacity group-hover:opacity-100" />
                </Link>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <Button asChild variant="outline" size="sm" className="shrink-0 gap-1.5">
        <Link href={githubUrl} target="_blank" rel="noreferrer noopener">
          <Github className="size-3.5" />
          <span className="sm:hidden">Edit</span>
          <span className="hidden sm:inline">Edit on GitHub</span>
        </Link>
      </Button>
    </div>
  );
}

/**
 * Copies the page's markdown source, with a transient confirmation (~2s)
 * before reverting. A fetch or clipboard failure reverts to the idle state
 * silently — no toast, per the docs surface's restrained chrome.
 *
 * The fetch does NOT happen in the click. It used to, which made every copy
 * cost a network round-trip before anything was on the clipboard — and on a
 * cold dev server, where `/markdown/[...path]` is compiled and rendered per
 * request, that is seconds of a button that looks stuck. The text never
 * depended on the click, so it no longer waits for one: pointing at the
 * button, tabbing to it, or pressing it starts the fetch, and by the time the
 * click lands `peek()` usually answers.
 *
 * That also puts the clipboard write back INSIDE the user gesture on the warm
 * path, which is the form Safari is strict about — an `await` in front of
 * `writeText` is exactly what it rejects.
 *
 * The confirmation is carried entirely by the icon: the copy glyph
 * cross-fades to a green check and the label stays "Copy Markdown"
 * throughout. Swapping the label to "Copied" changed the button's width
 * mid-row and shoved "Open" sideways for two seconds; a fixed-width label
 * with a morphing icon says the same thing without the reflow. The word
 * survives on `aria-label`, which is where a screen reader wants it anyway.
 *
 * The swap itself is the design system's icon-swap transition (blur + scale +
 * opacity, spring `duration: 0.3, bounce: 0`, `initial={false}` so nothing
 * animates on first paint) — the same one `components/markdown/copy-button.tsx`
 * uses for code blocks, so the two copy affordances in the docs read as one
 * control rather than two.
 */
function CopyMarkdownButton({ markdownPath }: { markdownPath: string }) {
  const [state, setState] = useState<CopyState>('idle');
  const resetTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Keyed on the path, so a client-side move to another docs page cannot copy
  // the page the reader just left.
  const source = useMemo(() => createMarkdownSource(markdownPath, fetch), [markdownPath]);

  useEffect(() => {
    return () => {
      if (resetTimeout.current) clearTimeout(resetTimeout.current);
    };
  }, []);

  // Named `confirmCopy`, not `markCopied`: the pin in `docs-page-actions.test.ts`
  // reads a capital-C "Copied" anywhere in this file as the visible label swap
  // coming back, and it is right to be that blunt about it.
  const confirmCopy = useCallback(() => {
    setState('copied');
    resetTimeout.current = setTimeout(() => setState('idle'), COPIED_RESET_MS);
  }, []);

  // Intent, not render: a reader who never reaches for this button never
  // issues the request. A rejection here is not the user's problem yet — the
  // click will surface it — so it is swallowed rather than left unhandled.
  const prefetch = useCallback(() => {
    void source.load().catch(() => {});
  }, [source]);

  const handleClick = useCallback(async () => {
    if (state === 'copying') return;

    // Warm: no await before the write, so the copy is instant and the gesture
    // is still the one the browser sees.
    const ready = source.peek();
    if (ready !== null) {
      try {
        await navigator.clipboard.writeText(ready);
        confirmCopy();
      } catch {
        setState('idle');
      }
      return;
    }

    setState('copying');
    try {
      await navigator.clipboard.writeText(await source.load());
      confirmCopy();
    } catch {
      setState('idle');
    }
  }, [confirmCopy, source, state]);

  const copied = state === 'copied';

  return (
    <Button
      variant="outline"
      size="sm"
      aria-label={copied ? 'Markdown copied' : 'Copy markdown'}
      // `px-2.5` is set by hand because the icon is no longer a direct `<svg>`
      // child, so `size="sm"`'s own `has-[>svg]:px-2.5` stops matching. Without
      // it this button would sit at `px-3` while "Open" and "Edit on GitHub"
      // stay at `px-2.5`.
      className={cn('shrink-0 gap-1.5 px-2.5', state === 'copying' && 'cursor-wait')}
      onClick={handleClick}
      // Three chances to be warm before the click: the pointer arriving, the
      // keyboard landing, and the press itself — `pointerdown` fires ahead of
      // `click`, which is the only head start a touch reader gets.
      onPointerEnter={prefetch}
      onPointerDown={prefetch}
      onFocus={prefetch}
      disabled={state === 'copying'}
    >
      {/* Both glyphs share one fixed box and overlap absolutely, so the blur
          bridges the crossfade instead of two icons trading places. */}
      <span className="relative inline-flex size-3.5 shrink-0 items-center justify-center">
        <AnimatePresence initial={false} mode="popLayout">
          <m.span
            key={copied ? 'check' : 'copy'}
            initial={{ scale: 0.25, opacity: 0, filter: 'blur(4px)' }}
            animate={{ scale: 1, opacity: 1, filter: 'blur(0px)' }}
            exit={{ scale: 0.25, opacity: 0, filter: 'blur(4px)' }}
            transition={{ type: 'spring', duration: 0.3, bounce: 0 }}
            className="absolute inset-0 inline-flex items-center justify-center"
          >
            {copied ? <CheckIcon className="size-3.5" /> : <Copy className="size-3.5" />}
          </m.span>
        </AnimatePresence>
      </span>
      <span className="sm:hidden">Copy</span>
      <span className="hidden sm:inline">Copy Markdown</span>
    </Button>
  );
}
