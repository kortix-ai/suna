'use client';

import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';
import { owning, type TreeNode } from './content';
import { Interlude, Panel } from './interlude';

/**
 * Interlude 2 — sits between the self-host slab and the trust card, with the
 * graphic on the LEFT so it reads as the answering half of interlude 1.
 *
 * WHAT IT FIXES. Open source, trust and the closing CTA are three heavy
 * surfaces of three different kinds landing back to back. This is the rest
 * between the first two, and it also finishes the argument the slab starts: the
 * slab proves you can run the code, this shows what you are actually holding
 * once you do.
 *
 * WHY A TREE. It is the one graphic on the page that can be rendered honestly
 * without a screenshot, because it is not a picture of a product — it is the
 * literal layout of `packages/starter/templates/base`, which is what a new
 * project ships with. Every path in `content.ts` was read off that directory.
 * If the starter changes, this changes.
 *
 * WHAT IT MUST NOT SHOW. No `channels:` key. The v2 manifest validator rejects
 * it; channel routing is live project state, which the shipped manifest's own
 * closing comment says in as many words. Drawing it here would be a copy bug
 * that teaches people to write a file that fails validation.
 *
 * Copy, and the accuracy gate every line of it had to pass, live in
 * `content.ts`. Read that file before editing a word here.
 */
/**
 * The `├─ │ └─` gutter, derived rather than hand-written.
 *
 * A node is the last child at its level when no later node returns to that
 * depth before the tree pops above it; an ancestor level still needs its
 * vertical guide when some later node does return to it. Computing this from
 * `depth` alone means `content.ts` stays a plain list of paths — nobody has to
 * redraw box characters by hand when a directory is added.
 */
function gutter(tree: readonly TreeNode[], index: number): string {
  const { depth } = tree[index];

  const continues = (level: number): boolean => {
    for (let i = index + 1; i < tree.length; i += 1) {
      if (tree[i].depth < level) return false;
      if (tree[i].depth === level) return true;
    }
    return false;
  };

  let out = '';
  for (let level = 0; level < depth; level += 1) out += continues(level) ? '│  ' : '   ';
  return `${out}${continues(depth) ? '├─ ' : '└─ '}`;
}

function TreeRow({ node, prefix }: { node: TreeNode; prefix: string }): ReactNode {
  return (
    <li className="grid grid-cols-1 items-baseline gap-x-6 px-4 py-[3px] sm:grid-cols-[minmax(0,17rem)_minmax(0,1fr)] sm:px-5">
      <span className="min-w-0 truncate font-mono text-[11.5px] leading-relaxed">
        <span aria-hidden className="text-muted-foreground/30 whitespace-pre select-none">
          {prefix}
        </span>
        <span className={cn(node.dir ? 'text-foreground' : 'text-foreground/70')}>{node.name}</span>
      </span>
      {/* Annotations sit in their own column so their left edge stays straight,
          rather than trailing each filename to a ragged right margin. */}
      <span className="text-muted-foreground/60 hidden min-w-0 truncate text-[11px] sm:block">
        {node.note ?? ''}
      </span>
    </li>
  );
}

function RepoPanel(): ReactNode {
  return (
    <Panel title={owning.panel.title} label={owning.panel.label} footer={owning.panel.footer}>
      <ul className="py-4">
        {owning.tree.map((node, index) => (
          <TreeRow key={`${node.depth}-${node.name}`} node={node} prefix={gutter(owning.tree, index)} />
        ))}
      </ul>
    </Panel>
  );
}

export function OwningInterlude(): ReactNode {
  return (
    <Interlude
      id="owning"
      eyebrow={owning.eyebrow}
      title={owning.title}
      paragraphs={owning.paragraphs}
      panel={<RepoPanel />}
      flip
    />
  );
}
