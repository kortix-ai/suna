import { Folder, FileText } from 'lucide-react';

import { cn } from '@/lib/utils';

interface TreeNode {
  name: string;
  children: Map<string, TreeNode>;
  isFile: boolean;
}

/** Build a nested tree from flat install targets like
 *  `@skills/generic-recruiting/references/sourcing.md`. */
function buildTree(targets: string[]): TreeNode {
  const root: TreeNode = { name: '', children: new Map(), isFile: false };
  for (const target of targets) {
    const parts = target.split('/').filter(Boolean);
    let node = root;
    parts.forEach((part, i) => {
      const isFile = i === parts.length - 1;
      let child = node.children.get(part);
      if (!child) {
        child = { name: part, children: new Map(), isFile };
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

function Rows({ node, depth }: { node: TreeNode; depth: number }) {
  return (
    <>
      {sortedChildren(node).map((child) => {
        if (child.isFile) {
          return (
            <div
              key={child.name}
              className="text-foreground/90 flex items-center gap-1.5 py-1 font-mono text-xs"
              style={{ paddingLeft: `${12 + depth * 14}px` }}
              title={child.name}
            >
              <FileText className="text-muted-foreground/50 size-3.5 shrink-0" />
              <span className="truncate">{child.name}</span>
            </div>
          );
        }
        const { label, node: folder } = collapse(child);
        return (
          <div key={child.name}>
            <div
              className="text-foreground flex items-center gap-1.5 py-1 font-mono text-xs font-medium"
              style={{ paddingLeft: `${12 + depth * 14}px` }}
              title={label}
            >
              <Folder className="text-muted-foreground/60 size-3.5 shrink-0" />
              <span className="truncate">{label}/</span>
            </div>
            <Rows node={folder} depth={depth + 1} />
          </div>
        );
      })}
    </>
  );
}

/** A nested file tree of an item's install targets — folders collapse
 *  single-child chains and sort before files. */
export function MarketplaceFileTree({ targets }: { targets: string[] }) {
  const root = buildTree(targets);
  return (
    <div className="bg-popover max-h-72 overflow-auto rounded-md border py-1 pr-2">
      <Rows node={root} depth={0} />
    </div>
  );
}
