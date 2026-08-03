'use client';

import { CopyButton } from '@/components/markdown/copy-button';
import { cn } from '@/lib/utils';
import React from 'react';

// A floating copy control over whatever the caller already drew.
//
// Three sites (write-tool, edit-tool, audit-tab) bring their own frame and only
// want the copy affordance on top of it. The alternative was pasting the same
// `absolute top-3 right-3 z-30` at each of them and watching them drift apart —
// the placement is `BetterCodeBlock`'s, kept byte-identical so those sites do
// not shift when they move over. The child is rendered as given: no clone, no
// extra element around it.
export function CopyOverlay({
  code,
  className,
  children,
}: {
  code: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn('group relative h-full w-full', className)}>
      {children}
      <div className="absolute top-3 right-3 z-30">
        <CopyButton code={code} />
      </div>
    </div>
  );
}
