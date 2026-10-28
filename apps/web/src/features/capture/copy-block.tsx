'use client';

import { CheckIcon, CopyIcon } from '@phosphor-icons/react';

import { Button } from '@kortix/ui/button';
import { useCopy } from '@kortix/ui/internal/hooks/use-copy';

/** A copyable block of text: an API URL, a request, a token or an install command. */
export function CopyBlock({ text, copyLabel }: { text: string; copyLabel: string }) {
  const { copy, copied } = useCopy();
  return (
    <div className="bg-muted flex items-start rounded-md border">
      <pre className="scrollbar-hide min-w-0 flex-1 overflow-x-auto py-2.5 pl-3 font-mono text-xs leading-relaxed">
        <code>{text}</code>
      </pre>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={() => copy(text)}
        aria-label={copyLabel}
        className="m-1 size-7 shrink-0"
      >
        {copied ? (
          <CheckIcon className="text-kortix-green size-3.5" />
        ) : (
          <CopyIcon className="size-3.5" />
        )}
      </Button>
    </div>
  );
}
