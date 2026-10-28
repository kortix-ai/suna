'use client';

import { YamlLine } from '@/features/marketing/code-panel';
import { MANIFEST, TREE } from '@/features/marketing/framework/content';
import { cn } from '@kortix/ui';
import { FileTextIcon, FolderSimpleIcon, GitBranchIcon, TerminalIcon } from '@phosphor-icons/react';
import { useRef } from 'react';

import { H, useFitScale, W } from './session-window';

/**
 * The same Northwind project as the session window, seen as code: its git
 * repository, with kortix.yaml open. Drawn at the session window's board size
 * and scaled the same way, so the two line up under the hero's slider.
 */
export function FrameworkWindow({ className }: { className?: string }) {
  const frame = useRef<HTMLDivElement>(null);
  const scale = useFitScale(frame);

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
            <div className="flex min-h-0 flex-1">
              <ul className="bg-sidebar w-64 shrink-0 border-r py-3 text-sm">
                {TREE.map((node) => (
                  <li
                    key={`${node.depth}-${node.name}`}
                    className={cn(
                      'flex items-center gap-2 py-1.5 pr-4',
                      'open' in node && node.open ? 'bg-muted text-foreground font-medium' : 'text-muted-foreground',
                    )}
                    style={{ paddingLeft: 20 + node.depth * 16 }}
                  >
                    {'dir' in node && node.dir ? (
                      <FolderSimpleIcon className="size-4 shrink-0" aria-hidden />
                    ) : (
                      <FileTextIcon className="size-4 shrink-0" aria-hidden />
                    )}
                    {node.name}
                  </li>
                ))}
              </ul>
              <div className="flex min-w-0 flex-1 flex-col">
                <div className="text-muted-foreground border-b px-5 py-2.5 font-mono text-xs">kortix.yaml</div>
                <ol className="min-h-0 flex-1 overflow-hidden py-3 font-mono text-sm leading-relaxed">
                  {MANIFEST.map((line, i) => (
                    <li key={i} className="flex gap-5 px-5 whitespace-pre">
                      <span className="text-muted-foreground w-6 shrink-0 text-right tabular-nums select-none">{i + 1}</span>
                      <span>
                        <YamlLine line={line} />
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
