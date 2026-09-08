'use client';

import { FileTextIcon, FolderIcon } from '@phosphor-icons/react';

import { cn } from '@/lib/utils';

interface TreeNode {
  name: string;
  /** Full repo path — only files carry one; it is the key a viewer fetches by. */
  path: string;
  children: Map<string, TreeNode>;
  isFile: boolean;
}

/** Nest flat repo paths like `.kortix/opencode/agents/sre.md`. */
function buildTree(paths: string[]): TreeNode {
  const root: TreeNode = { name: '', path: '', children: new Map(), isFile: false };
  for (const path of paths) {
    const parts = path.split('/').filter(Boolean);
    let node = root;
    parts.forEach((part, index) => {
      const isFile = index === parts.length - 1;
      let child = node.children.get(part);
      if (!child) {
        child = { name: part, path: isFile ? path : '', children: new Map(), isFile };
        node.children.set(part, child);
      }
      node = child;
    });
  }
  return root;
}

/**
 * Collapse a single-child folder chain into one row, git-style
 * (`.kortix/opencode/agents/`), so a deep repo does not become a staircase in a
 * rail this narrow.
 */
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

/** Folders first, then files, each alphabetical — the order a repo is read in. */
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
  onSelect?: (path: string) => void;
}) {
  return (
    <>
      {sortedChildren(node).map((child) => {
        // Indentation is the one value here that cannot be a token: it is a
        // function of tree depth, which is data.
        const indent = { paddingLeft: `${8 + depth * 14}px` };
        if (child.isFile) {
          const active = selected === child.path;
          return (
            <button
              key={child.name}
              type="button"
              onClick={() => onSelect?.(child.path)}
              title={child.path}
              style={indent}
              className={cn(
                'duration-normal flex w-full cursor-pointer items-center gap-1.5 rounded-sm py-1 pr-2 text-left font-mono text-xs transition-colors ease-out',
                active
                  ? 'bg-primary/[0.07] text-foreground font-medium'
                  : 'text-muted-foreground hover:bg-hover hover:text-foreground',
              )}
            >
              <FileTextIcon className="text-muted-foreground/50 size-3.5 shrink-0" aria-hidden />
              <span className="truncate">{child.name}</span>
            </button>
          );
        }
        const { label, node: folder } = collapse(child);
        return (
          <div key={child.name}>
            <div
              className="text-foreground flex items-center gap-1.5 py-1 pr-2 font-mono text-xs font-medium"
              style={indent}
              title={label}
            >
              <FolderIcon className="text-muted-foreground/60 size-3.5 shrink-0" aria-hidden />
              <span className="truncate">{label}/</span>
            </div>
            <Rows node={folder} depth={depth + 1} selected={selected} onSelect={onSelect} />
          </div>
        );
      })}
    </>
  );
}

/**
 * The template repository's files, as a tree.
 *
 * Every file listed is one the viewer can open — the API leaves binaries out of
 * the listing — so a row that looks clickable always is. Folders are structure
 * only and do not toggle: the whole tree is already expanded, which for a
 * curated template repo is a few dozen rows and beats making a reader hunt for
 * a document through collapsed nodes.
 */
export function TemplateFileTree({
  paths,
  selected,
  onSelect,
  className,
}: {
  paths: string[];
  selected?: string;
  onSelect?: (path: string) => void;
  className?: string;
}) {
  return (
    <div className={cn('py-1 pl-1', className)}>
      <Rows node={buildTree(paths)} depth={0} selected={selected} onSelect={onSelect} />
    </div>
  );
}
