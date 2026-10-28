'use client';

import { YamlLine } from '@/features/marketing/code-panel';
import { FILES, TREE } from '@/features/marketing/framework/content';
import { cn } from '@kortix/ui';
import { FileTextIcon, FolderSimpleIcon, GitBranchIcon, TerminalIcon } from '@phosphor-icons/react';
import { useRef, useState } from 'react';

import { H, useFitScale, W } from './session-window';

/** One line of an open file: YAML and frontmatter tinted, Markdown headings in weight. */
function Line({ path, line, inFrontmatter }: { path: string; line: string; inFrontmatter: boolean }) {
  if (path.endsWith('.yaml') || inFrontmatter || line === '---') return <YamlLine line={line} />;
  if (line.startsWith('#')) return <span className="text-foreground font-medium">{line}</span>;
  return <span className="text-muted-foreground">{line}</span>;
}

/**
 * The same Northwind project as the session window, seen as code: its git
 * repository, with every file in the tree clickable. kortix.yaml is open by
 * default. Drawn at the session window's board size and scaled the same way.
 * `onInteract` tells the hero's switcher that the reader is exploring.
 */
export function FrameworkWindow({ className, onInteract }: { className?: string; onInteract?: () => void }) {
  const frame = useRef<HTMLDivElement>(null);
  const scale = useFitScale(frame);
  const [open, setOpen] = useState('kortix.yaml');
  const lines = FILES[open] ?? [];
  // Frontmatter: the lines between the first two `---` of a Markdown file.
  const fenceEnd = lines[0] === '---' ? lines.indexOf('---', 1) : -1;

  return (
    <div ref={frame} className={cn('relative w-full', className)} style={{ aspectRatio: `${W} / ${H}` }}>
      <div
        className="absolute top-0 left-0 origin-top-left"
        style={{ width: W, height: H, transform: `scale(${scale})` }}
      >
        <div className="bg-background/20 ring-border flex size-full rounded-2xl p-2 ring-1">
          <div className="bg-background text-foreground flex size-full flex-col overflow-hidden rounded-xl border">
            <div className="flex h-12 shrink-0 items-center gap-3 border-b px-5 text-sm">
              <span className="font-medium">northwind-operations</span>
              <span className="text-muted-foreground flex items-center gap-1.5 font-mono text-xs">
                <GitBranchIcon className="size-3.5" aria-hidden />
                main
              </span>
            </div>
            <div className="grid min-h-0 flex-1 grid-cols-[20rem_1fr]">
              <ul className="bg-sidebar overflow-hidden border-r py-3 text-sm" aria-label="Repository files">
                {TREE.map((node) =>
                  node.path ? (
                    <li key={node.path}>
                      <button
                        type="button"
                        onClick={() => {
                          setOpen(node.path!);
                          onInteract?.();
                        }}
                        aria-current={open === node.path ? 'true' : undefined}
                        className="text-muted-foreground hover:text-foreground aria-[current]:bg-muted aria-[current]:text-foreground flex w-full items-center gap-2 py-1.5 pr-4 text-left aria-[current]:font-medium"
                        style={{ paddingLeft: 20 + node.depth * 16 }}
                      >
                        <FileTextIcon className="size-4 shrink-0" aria-hidden />
                        <span className="truncate">{node.name}</span>
                      </button>
                    </li>
                  ) : (
                    <li
                      key={node.name}
                      className="text-foreground flex items-center gap-2 pt-3 pr-4 pb-1.5 font-medium first:pt-1.5"
                      style={{ paddingLeft: 20 + node.depth * 16 }}
                    >
                      <FolderSimpleIcon className="size-4 shrink-0" aria-hidden />
                      {node.name}
                    </li>
                  ),
                )}
              </ul>
              <div className="flex min-h-0 min-w-0 flex-col">
                <div className="text-muted-foreground border-b px-5 py-2.5 font-mono text-xs">{open}</div>
                <ol className="min-h-0 flex-1 overflow-hidden py-3 font-mono text-sm leading-relaxed">
                  {lines.map((line, i) => (
                    <li key={`${open}-${i}`} className="flex gap-5 px-5 whitespace-pre">
                      <span className="text-muted-foreground w-6 shrink-0 text-right tabular-nums select-none">
                        {i + 1}
                      </span>
                      <span>
                        <Line path={open} line={line} inFrontmatter={i > 0 && i < fenceEnd} />
                      </span>
                    </li>
                  ))}
                </ol>
                <div className="flex items-center gap-2 border-t px-5 py-3 font-mono text-sm">
                  <TerminalIcon className="text-muted-foreground size-4" aria-hidden />
                  <span className="text-muted-foreground select-none">$</span>
                  <span>kortix ship</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
