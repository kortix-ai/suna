'use client';

import type { ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure';
import { cn } from '@/lib/utils';
import { CaretRightIcon } from '@phosphor-icons/react';

export interface FileTreeProps {
  title: ReactNode;
  children?: ReactNode;
  className?: string;
}

/**
 * Collapsible file-tree shell: ghost trigger with caret, content below.
 * Callers own the tree rows (or any children) — this only owns the disclosure chrome.
 */
export function FileTree({ title, children, className }: FileTreeProps) {
  return (
    <Disclosure open className={cn('group', className)}>
      <DisclosureTrigger>
        <Button
          variant="ghost"
          size="sm"
          className="flex w-full items-center justify-between gap-1.5"
        >
          {title}
          <CaretRightIcon className="text-muted-foreground size-3.5 transition-transform duration-200 group-data-[state=open]:rotate-90" />
        </Button>
      </DisclosureTrigger>
      <DisclosureContent>
        <div className="mt-1">{children}</div>
      </DisclosureContent>
    </Disclosure>
  );
}
