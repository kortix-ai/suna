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
import { CheckIcon } from '@/lib/icons/ssr';
import { cn } from '@/lib/utils';
// `docs-page-actions.tsx` is 'use client', so — unlike page.tsx/layout.tsx —
// it is the one place in the docs surface allowed to dot into the client
// `Icon` namespace directly.
import { ArrowSquareOutIcon, CaretDownIcon, MarkdownLogoIcon } from '@phosphor-icons/react';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';

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
      href: `/workspaces/start?q=${encodedPrompt}`,
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
 * Fetches the page's markdown source and copies it to the clipboard, with a
 * transient "Copied" state (~2s) before reverting. A fetch or clipboard
 * failure reverts to the idle label silently — no toast, per the docs
 * surface's restrained chrome.
 */
function CopyMarkdownButton({ markdownPath }: { markdownPath: string }) {
  const [state, setState] = useState<CopyState>('idle');
  const resetTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (resetTimeout.current) clearTimeout(resetTimeout.current);
    };
  }, []);

  const handleClick = useCallback(async () => {
    if (state === 'copying') return;
    setState('copying');
    try {
      const response = await fetch(markdownPath);
      if (!response.ok) throw new Error(`Failed to fetch ${markdownPath}: ${response.status}`);
      const text = await response.text();
      await navigator.clipboard.writeText(text);
      setState('copied');
      resetTimeout.current = setTimeout(() => setState('idle'), COPIED_RESET_MS);
    } catch {
      setState('idle');
    }
  }, [markdownPath, state]);

  return (
    <Button
      variant="outline"
      size="sm"
      className={cn('shrink-0 gap-1.5', state === 'copying' && 'cursor-wait')}
      onClick={handleClick}
      disabled={state === 'copying'}
    >
      {state === 'copied' ? <CheckIcon className="size-3.5" /> : <Copy className="size-3.5" />}
      {state === 'copied' ? (
        'Copied'
      ) : (
        <>
          <span className="sm:hidden">Copy</span>
          <span className="hidden sm:inline">Copy Markdown</span>
        </>
      )}
    </Button>
  );
}
