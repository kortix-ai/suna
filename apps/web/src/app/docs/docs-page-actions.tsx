'use client';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Icon } from '@/features/icon/icon';
import { CheckIcon, FileTextIcon } from '@/lib/icons/ssr';
import { cn } from '@/lib/utils';
// `docs-page-actions.tsx` is 'use client', so — unlike page.tsx/layout.tsx —
// it is the one place in the docs surface allowed to dot into the client
// `Icon` namespace directly.
import { ArrowSquareOutIcon, CaretDownIcon } from '@phosphor-icons/react';
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
}: {
  markdownPath: string;
  githubUrl: string;
  pageUrl: string;
}) {
  const prompt = `Read ${pageUrl} so I can ask questions about it.`;
  const encodedPrompt = encodeURIComponent(prompt);

  const openActions: OpenAction[] = [
    { key: 'github', label: 'Open in GitHub', href: githubUrl, icon: Icon.Github },
    { key: 'markdown', label: 'View as Markdown', href: markdownPath, icon: FileTextIcon },
    {
      key: 'chatgpt',
      label: 'Open in ChatGPT',
      href: `https://chatgpt.com/?q=${encodedPrompt}`,
      icon: Icon.ChatGPT,
    },
    {
      key: 'claude',
      label: 'Open in Claude',
      href: `https://claude.ai/new?q=${encodedPrompt}`,
      icon: Icon.Claude,
    },
    {
      key: 'cursor',
      label: 'Open in Cursor',
      href: `cursor://anysphere.cursor-deeplink/prompt?text=${encodedPrompt}`,
      icon: Icon.Cursor,
    },
    {
      key: 'kortix',
      label: 'Open in Kortix',
      href: `/projects/start?q=${encodedPrompt}`,
      icon: Icon.Kortix,
    },
  ];

  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <CopyMarkdownButton markdownPath={markdownPath} />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="xs" className="gap-1.5">
            Open
            <CaretDownIcon className="size-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {openActions.map(({ key, label, href, icon: ItemIcon }) => (
            <DropdownMenuItem key={key} asChild>
              <a href={href} target="_blank" rel="noreferrer noopener">
                <ItemIcon className="size-3.5" />
                <span className="min-w-0 flex-1">{label}</span>
                <ArrowSquareOutIcon className="text-muted-foreground size-3.5" />
              </a>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <Button asChild variant="outline" size="xs" className="gap-1.5">
        <a href={githubUrl} target="_blank" rel="noreferrer noopener">
          <Icon.Github className="size-3.5" />
          Edit on GitHub
        </a>
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
      size="xs"
      className={cn('gap-1.5', state === 'copying' && 'cursor-wait')}
      onClick={handleClick}
      disabled={state === 'copying'}
    >
      {state === 'copied' ? (
        <CheckIcon className="size-3.5" />
      ) : (
        <Icon.Copy className="size-3.5" />
      )}
      {state === 'copied' ? 'Copied' : 'Copy Markdown'}
    </Button>
  );
}
