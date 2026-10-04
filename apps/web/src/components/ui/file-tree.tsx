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
 * Collapsible file-tree shell: ghost trigger with caret, rows inside the
 * disclosure content. Uncontrolled and open by default — clicking the title
 * collapses it (a bare `open` would freeze it; see `DisclosureProps.open`).
 * Callers own the tree rows (or any children) — this only owns the disclosure chrome.
 */
export function FileTree({ title, children, className }: FileTreeProps) {
  return (
    <Disclosure defaultOpen className={cn('group', className)}>
      <DisclosureTrigger>
        <Button
          variant="ghost"
          size="sm"
          className="flex w-full items-center justify-between gap-1.5"
        >
          {title}
          <CaretRightIcon className="text-muted-foreground size-3.5 transition-transform duration-(--duration-moderate) group-data-[state=open]:rotate-90" />
        </Button>
      </DisclosureTrigger>
      <DisclosureContent>
        <div className="mt-1">{children}</div>
      </DisclosureContent>
    </Disclosure>
  );
}

export interface FileTreeNode {
  name: string;
  path: string;
  /** Nesting below the tree's root directory. 0 = sits directly in it. */
  depth: number;
}

export interface FileTreeNavProps {
  nodes: readonly FileTreeNode[];
  selectedPath: string | undefined;
  onSelect: (path: string) => void;
  /** Accessible name for the list, e.g. "account-research files". */
  label: string;
}

/**
 * The file rows inside a `FileTree`: one indented button per file, the
 * selected one on a quiet fill. Shared by the capability entity modal and the
 * marketplace item rail so both trees are the same component.
 */
export function FileTreeNav({ nodes, selectedPath, onSelect, label }: FileTreeNavProps) {
  if (nodes.length === 0) return null;
  return (
    <nav aria-label={label} className="space-y-0.5">
      {nodes.map((node) => (
        <button
          key={node.path}
          type="button"
          onClick={() => onSelect(node.path)}
          aria-current={node.path === selectedPath}
          // Root rows start on the trigger's text lane (`px-2.5`, the ghost
          // `sm` button's inset with an icon), so file names sit under the title.
          style={{ paddingLeft: `calc(var(--spacing) * 2.5 + ${node.depth * 12}px)` }}
          className={cn(
            'block w-full truncate rounded-md py-1.5 pr-2 text-left text-xs transition-colors',
            'focus-visible:ring-ring/50 focus-visible:ring-2 focus-visible:outline-none',
            node.path === selectedPath
              ? 'bg-primary/[0.06] text-foreground'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {node.name}
        </button>
      ))}
    </nav>
  );
}
