'use client';

import { CopyButton } from '@/components/markdown/copy-button';
import { Button } from '@/components/ui/button';
import Hint from '@/components/ui/hint';
import { ArrowSquareOutIcon } from '@phosphor-icons/react';

export function ChatGptDeviceChallenge({ url, code }: { url: string; code: string | null }) {
  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <p className="text-foreground text-xs font-medium">Copy your device code</p>
        <p className="text-muted-foreground text-xs leading-5 text-pretty">
          Copy this code. Then open the auth page and enter it to connect ChatGPT.
        </p>
      </div>

      {code ? (
        <div className="border-border bg-muted flex min-h-10 items-center gap-2 rounded-sm border py-1 pr-1 pl-3">
          <code className="text-foreground min-w-0 flex-1 font-mono text-lg font-semibold tracking-widest tabular-nums">
            {code}
          </code>
          <Hint label="Copy code">
            <CopyButton code={code} className="size-10 shrink-0" />
          </Hint>
        </div>
      ) : null}

      {url ? (
        <Button type="button" size="sm" variant="outline" className="h-8 gap-1.5 px-3" asChild>
          <a href={url} target="_blank" rel="noopener noreferrer">
            <ArrowSquareOutIcon className="size-3.5 shrink-0" />
            Open auth page
          </a>
        </Button>
      ) : null}
    </div>
  );
}
