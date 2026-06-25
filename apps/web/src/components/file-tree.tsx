'use client';

/**
 * Shared VS Code–style recursive file tree.
 *
 * One row shape — indent rails, then `[chevron | spacer] · icon · label` — so
 * folders and the files within them all line up in a single column. Used by the
 * Customize → Skills browser and the Marketplace item preview so both render an
 * identical tree. File-type icons come from Pierre's sprite sheet (colored per
 * extension); render <FileTreeSprite/> once near the tree so the `<use>` refs
 * resolve.
 */

import { type ReactNode } from 'react';
import {
  createFileTreeIconResolver,
  getBuiltInFileIconColor,
  getBuiltInSpriteSheet,
} from '@pierre/trees';
import { ChevronRight, Folder, Folder as FolderOpen } from '@mynaui/icons-react';

import { cn } from '@/lib/utils';

const pierreIconResolver = createFileTreeIconResolver('complete');
const pierreSpriteSheet = getBuiltInSpriteSheet('complete');

export interface FileNode {
  name: string;
  /** Path relative to the tree root (also the unique key). */
  path: string;
  isDir: boolean;
  children: FileNode[];
}

/** Build a recursive tree from a flat list of relative paths. Directories are
 *  synthesized from the path segments. */
export function buildFileTree(relPaths: readonly string[]): FileNode[] {
  const roots: FileNode[] = [];
  const byPath = new Map<string, FileNode>();
  for (const rel of relPaths) {
    const parts = rel.split('/').filter(Boolean);
    let siblings = roots;
    let prefix = '';
    for (let i = 0; i < parts.length; i++) {
      const isFile = i === parts.length - 1;
      prefix = prefix ? `${prefix}/${parts[i]}` : parts[i]!;
      let node = byPath.get(prefix);
      if (!node) {
        node = { name: parts[i]!, path: prefix, isDir: !isFile, children: [] };
        byPath.set(prefix, node);
        siblings.push(node);
      }
      siblings = node.children;
    }
  }
  sortNodes(roots);
  return roots;
}

function sortNodes(nodes: FileNode[]): void {
  nodes.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    // SKILL.md floats to the top of its folder as the canonical doc.
    if (!a.isDir && a.name === 'SKILL.md') return -1;
    if (!b.isDir && b.name === 'SKILL.md') return 1;
    return a.name.localeCompare(b.name);
  });
  for (const node of nodes) if (node.isDir) sortNodes(node.children);
}

/** Every directory path in the tree — handy to seed a fully-expanded view. */
export function collectDirPaths(nodes: readonly FileNode[], out: string[] = []): string[] {
  for (const n of nodes) {
    if (n.isDir) {
      out.push(n.path);
      collectDirPaths(n.children, out);
    }
  }
  return out;
}

/* ─── Tree-row primitives ────────────────────────────────────────────────────
   Full-bleed, flush rows so the indent rails read as continuous verticals;
   indent grows 16px per level; selection is a tinted-primary bar, never a flat
   grey fill (design-system rule). */

const INDENT_STEP = 16; // px per nesting level
const GUTTER = 8; // px before the first chevron at the root

/** Faint vertical indent guides, one hairline per ancestor level — the way VS
 *  Code draws them. Root rows (depth 0) get none, just the gutter. */
function TreeGuides({ depth }: { depth: number }) {
  return (
    <span className="flex shrink-0 self-stretch" style={{ paddingLeft: GUTTER }} aria-hidden="true">
      {Array.from({ length: depth }).map((_, i) => (
        <span
          key={i}
          className="shrink-0 self-stretch border-l border-border/50"
          style={{ width: INDENT_STEP }}
        />
      ))}
    </span>
  );
}

/** Disclosure chevron for expandable rows. */
function TreeChevron({ open }: { open: boolean }) {
  return (
    <ChevronRight
      className={cn(
        'h-3.5 w-3.5 shrink-0 text-muted-foreground/60 transition-transform duration-fast',
        open && 'rotate-90',
      )}
    />
  );
}

/** A chevron-width spacer so files keep their icon aligned under folder icons. */
function TreeRowSpacer() {
  return <span className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />;
}

/** The shared row: full-bleed, fixed-height, indent rails on the left, then a
 *  gapped [chevron | spacer] · icon · label cluster. `interactive=false` renders
 *  a static (non-clickable) row for read-only previews. */
function TreeRow({
  depth,
  selected,
  ariaExpanded,
  onClick,
  interactive = true,
  children,
}: {
  depth: number;
  selected?: boolean;
  ariaExpanded?: boolean;
  onClick?: () => void;
  interactive?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={ariaExpanded}
      className={cn(
        'group flex h-7 w-full items-center text-left text-sm transition-colors duration-fast',
        interactive ? 'cursor-pointer' : 'cursor-default',
        selected
          ? 'bg-primary/[0.08] text-primary'
          : interactive
            ? 'text-foreground/80 hover:bg-muted/50 hover:text-foreground'
            : 'text-foreground/80',
      )}
    >
      {/* TreeGuides always emits the left gutter (plus a rail per level), so the
          content cluster never adds its own left padding. */}
      <TreeGuides depth={depth} />
      <span className="flex min-w-0 flex-1 items-center gap-1.5 pr-2">{children}</span>
    </button>
  );
}

/** A file-type icon from Pierre's sprite sheet (colored per extension). */
function PierreFileIcon({ path, className }: { path: string; className?: string }) {
  const icon = pierreIconResolver.resolveIcon('file-tree-icon-file', path);
  const color = icon.token ? getBuiltInFileIconColor(icon.token) : undefined;
  const name = icon.name.replace(/^#/, '');
  const width = icon.width ?? 16;
  const height = icon.height ?? 16;
  return (
    <svg
      aria-hidden="true"
      className={className}
      data-icon-name={icon.remappedFrom ?? icon.name}
      data-icon-token={icon.token}
      viewBox={icon.viewBox ?? `0 0 ${width} ${height}`}
      width={width}
      height={height}
      style={{ color }}
    >
      <use href={`#${name}`} />
    </svg>
  );
}

/** Hidden Pierre sprite sheet — render ONCE near the tree so the file icons can
 *  resolve their `<use href="#…">` references. */
export function FileTreeSprite() {
  return (
    <span
      className="pointer-events-none absolute h-0 w-0 overflow-hidden"
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: pierreSpriteSheet }}
    />
  );
}

function FileTreeNode({
  node,
  depth,
  rootPath,
  isExpanded,
  onToggle,
  selectedPath,
  onSelectFile,
}: {
  node: FileNode;
  depth: number;
  rootPath: string;
  isExpanded: (path: string) => boolean;
  onToggle: (path: string) => void;
  selectedPath?: string | null;
  onSelectFile?: (fullPath: string) => void;
}) {
  if (!node.isDir) {
    const fullPath = rootPath ? `${rootPath}/${node.path}` : node.path;
    const selectable = !!onSelectFile;
    return (
      <TreeRow
        depth={depth}
        interactive={selectable}
        selected={selectable && fullPath === selectedPath}
        onClick={selectable ? () => onSelectFile!(fullPath) : undefined}
      >
        <TreeRowSpacer />
        <PierreFileIcon path={node.name} className="h-4 w-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{node.name}</span>
      </TreeRow>
    );
  }

  const open = isExpanded(node.path);
  return (
    <>
      <TreeRow depth={depth} ariaExpanded={open} onClick={() => onToggle(node.path)}>
        <TreeChevron open={open} />
        {open ? (
          <FolderOpen className="h-4 w-4 shrink-0 text-muted-foreground/70" />
        ) : (
          <Folder className="h-4 w-4 shrink-0 text-muted-foreground/70" />
        )}
        <span className="min-w-0 flex-1 truncate">{node.name}</span>
      </TreeRow>
      {open &&
        node.children.map((child) => (
          <FileTreeNode
            key={child.path}
            node={child}
            depth={depth + 1}
            rootPath={rootPath}
            isExpanded={isExpanded}
            onToggle={onToggle}
            selectedPath={selectedPath}
            onSelectFile={onSelectFile}
          />
        ))}
    </>
  );
}

/** The recursive tree. Render a single <FileTreeSprite/> alongside it. Pass
 *  `onSelectFile` to make files clickable (skills browser); omit it for a
 *  read-only preview (marketplace). */
export function FileTree({
  nodes,
  rootPath = '',
  isExpanded,
  onToggle,
  selectedPath,
  onSelectFile,
}: {
  nodes: readonly FileNode[];
  rootPath?: string;
  isExpanded: (path: string) => boolean;
  onToggle: (path: string) => void;
  selectedPath?: string | null;
  onSelectFile?: (fullPath: string) => void;
}) {
  return (
    <>
      {nodes.map((node) => (
        <FileTreeNode
          key={node.path}
          node={node}
          depth={0}
          rootPath={rootPath}
          isExpanded={isExpanded}
          onToggle={onToggle}
          selectedPath={selectedPath}
          onSelectFile={onSelectFile}
        />
      ))}
    </>
  );
}
