import { Folder, FileText } from 'lucide-react';

import { cn } from '@/lib/utils';

interface TreeNode {
  name: string;
  /** Full install target (files only) — the key a viewer fetches by. */
  path: string;
  children: Map<string, TreeNode>;
  isFile: boolean;
}

/** Build a nested tree from flat install targets like
 *  `@skills/generic-recruiting/references/sourcing.md`. */
function buildTree(targets: string[]): TreeNode {
  const root: TreeNode = { name: '', path: '', children: new Map(), isFile: false };
  for (const target of targets) {
    const parts = target.split('/').filter(Boolean);
    let node = root;
    parts.forEach((part, i) => {
      const isFile = i === parts.length - 1;
      let child = node.children.get(part);
      if (!child) {
        child = { name: part, path: isFile ? target : '', children: new Map(), isFile };
        node.children.set(part, child);
      }
      node = child;
    });
  }
  return root;
}

/** Collapse a single-child folder chain into one row, git-style
 *  (`@skills/generic-recruiting/`), so the tree stays compact. */
function collapse(node: TreeNode): { label: string; node: TreeNode } {
  let label = node.name;
  let current = node;
  while (!current.isFile && current.children.size === 1) {
    const only = [...current.children.values()][0];
    if (only.isFile) break;
    label += `/${only.name}`;
    current = only;
  }
  return { label, node: current };
}

function sortedChildren(node: TreeNode): TreeNode[] {
  return [...node.children.values()].sort((a, b) =>
    a.isFile === b.isFile ? a.name.localeCompare(b.name) : a.isFile ? 1 : -1,
  );
}

function Rows({
  node,
  depth,
  selected,
  onSelect,
}: {
  node: TreeNode;
  depth: number;
  selected?: string;
  onSelect?: (target: string) => void;
}) {
  return (
    <>
      {sortedChildren(node).map((child) => {
        const pad = { paddingLeft: `${8 + depth * 14}px` };
        if (child.isFile) {
          const active = selected === child.path;
          return (
            <button
              key={child.name}
              type="button"
              onClick={() => onSelect?.(child.path)}
              title={child.name}
              className={cn(
                'flex w-full items-center gap-1.5 rounded py-1 pr-2 text-left font-mono text-xs transition-colors',
                active
                  ? 'bg-primary/[0.07] text-foreground font-medium'
                  : 'text-foreground/80 hover:bg-foreground/5 hover:text-foreground',
              )}
              style={pad}
            >
              <FileText className="text-muted-foreground/50 size-3.5 shrink-0" />
              <span className="truncate">{child.name}</span>
            </button>
          );
        }
        const { label, node: folder } = collapse(child);
        return (
          <div key={child.name}>
            <div
              className="text-foreground/90 flex items-center gap-1.5 py-1 pr-2 font-mono text-xs font-medium"
              style={pad}
              title={label}
            >
              <Folder className="text-muted-foreground/60 size-3.5 shrink-0" />
              <span className="truncate">{label}/</span>
            </div>
            <Rows node={folder} depth={depth + 1} selected={selected} onSelect={onSelect} />
          </div>
        );
      })}
    </>
  );
}

/** A nested file tree of an item's install targets. Files are selectable when
 *  `onSelect` is given; folders collapse single-child chains and sort first. */
export function MarketplaceFileTree({
  targets,
  selected,
  onSelect,
  className,
}: {
  targets: string[];
  selected?: string;
  onSelect?: (target: string) => void;
  className?: string;
}) {
  const root = buildTree(targets);
  return (
    <div className={cn('py-1 pl-1', className)}>
      <Rows node={root} depth={0} selected={selected} onSelect={onSelect} />
    </div>
  );
}
