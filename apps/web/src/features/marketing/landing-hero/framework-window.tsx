'use client';

import { YamlLine } from '@/features/marketing/code-panel';
import { FILES, TREE } from '@/features/marketing/framework/content';
import { cn } from '@kortix/ui';
import { FileTextIcon, FolderSimpleIcon, GitBranchIcon, TerminalIcon } from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';

import { H, useFitScale, W } from './session-window';
import { useBeats } from './use-beats';

/** One line of an open file: YAML and frontmatter tinted, Markdown headings in weight. */
function Line({
  path,
  line,
  inFrontmatter,
}: {
  path: string;
  line: string;
  inFrontmatter: boolean;
}) {
  if (path.endsWith('.yaml') || inFrontmatter || line === '---') return <YamlLine line={line} />;
  if (line.startsWith('#')) return <span className="text-foreground font-medium">{line}</span>;
  return <span className="text-muted-foreground">{line}</span>;
}

/** Lines `from` to `to` (1-based, inclusive) of `file`: opened, scrolled to, the rest dimmed. */
export type FrameworkFocus = { file: string; from: number; to: number };

/**
 * What `kortix ship` and `kortix cr ls` print, in the shapes of
 * apps/cli/src/commands/ship.ts and cr.ts. Sample data only.
 */
const SHIP_OUTPUT = [
  '  ✓  kortix.yaml verified',
  '  ✓  Shipped arcadia',
  '$ kortix cr ls',
  '  #    STATUS      FROM → INTO          TITLE',
  '  #12  ● open      weekly-post → main   Add the weekly LinkedIn post',
] as const;

/** One output line every ~0.5 s, as a terminal prints them. */
const SHIP_BEATS = [500, 1100, 1900, 2400, 2800] as const;

function ShipOutput() {
  const printed = useBeats(true, SHIP_BEATS);
  return SHIP_OUTPUT.slice(0, printed).map((line) => (
    <p
      key={line}
      className={cn(
        'animate-in fade-in duration-slow pl-6 whitespace-pre ease-out',
        line.startsWith('$') || line.includes('#12') ? 'text-foreground' : 'text-muted-foreground',
      )}
    >
      {line}
    </p>
  ));
}

/**
 * The same Arcadia project as the session window, seen as code: its git
 * repository, with every file in the tree clickable. kortix.yaml is open by
 * default. Drawn at the session window's board size and scaled the same way,
 * with no frame of its own: the hero's player draws it.
 * `onInteract` tells the hero's switcher that the reader is exploring.
 * `focus` opens a file at a line range; `shipped` prints the ship output in
 * the terminal. A click on a file still opens it.
 */
export function FrameworkWindow({
  className,
  onInteract,
  focus,
  shipped = false,
}: {
  className?: string;
  onInteract?: () => void;
  focus?: FrameworkFocus;
  shipped?: boolean;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const scale = useFitScale(frame);
  const code = useRef<HTMLOListElement>(null);
  const [open, setOpen] = useState(focus?.file ?? 'kortix.yaml');
  const focused = focus?.file === open ? focus : undefined;

  // A new focus reopens its file (state adjusted during render, not in an effect).
  const [lastFocus, setLastFocus] = useState(focus);
  if (focus !== lastFocus) {
    setLastFocus(focus);
    if (focus) setOpen(focus.file);
  }

  // Scroll the code pane only (never the page) so the range starts near the
  // top, and again when the terminal's output shrinks the pane.
  useEffect(() => {
    const list = code.current;
    const first = list?.querySelector<HTMLElement>(`[data-line="${focused?.from ?? 1}"]`);
    if (!list || !first) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const scroll = () =>
      list.scrollTo({
        top: Math.max(0, first.offsetTop - 12),
        behavior: reduced ? 'auto' : 'smooth',
      });
    const ro = new ResizeObserver(scroll);
    ro.observe(list);
    return () => ro.disconnect();
  }, [open, focused]);
  const lines = FILES[open] ?? [];
  // Frontmatter: the lines between the first two `---` of a Markdown file.
  const fenceEnd = lines[0] === '---' ? lines.indexOf('---', 1) : -1;

  return (
    <div
      ref={frame}
      className={cn('relative w-full', className)}
      style={{ aspectRatio: `${W} / ${H}` }}
    >
      <div
        className="absolute top-0 left-0 origin-top-left"
        style={{ width: W, height: H, transform: `scale(${scale})` }}
      >
        <div className="flex size-full">
          <div className="bg-background text-foreground flex size-full flex-col overflow-hidden">
            <div className="flex h-12 shrink-0 items-center gap-3 border-b px-5 text-sm">
              <span className="font-medium">arcadia</span>
              <span className="text-muted-foreground flex items-center gap-1.5 font-mono text-xs">
                <GitBranchIcon className="size-3.5" aria-hidden />
                main
              </span>
            </div>
            <div className="grid min-h-0 flex-1 grid-cols-[20rem_1fr]">
              <ul
                className="bg-sidebar overflow-hidden border-r py-3 text-sm"
                aria-label="Repository files"
              >
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
                        className="text-muted-foreground hover:text-foreground aria-[current]:bg-muted aria-[current]:text-foreground flex w-full items-center gap-2 py-1 pr-4 text-left aria-[current]:font-medium"
                        style={{ paddingLeft: 20 + node.depth * 16 }}
                      >
                        <FileTextIcon className="size-4 shrink-0" aria-hidden />
                        <span className="truncate">{node.name}</span>
                      </button>
                    </li>
                  ) : (
                    <li
                      key={node.name}
                      className="text-foreground flex items-center gap-2 pt-2 pr-4 pb-1 font-medium first:pt-1"
                      style={{ paddingLeft: 20 + node.depth * 16 }}
                    >
                      <FolderSimpleIcon className="size-4 shrink-0" aria-hidden />
                      {node.name}
                    </li>
                  ),
                )}
              </ul>
              <div className="flex min-h-0 min-w-0 flex-col">
                <div className="text-muted-foreground border-b px-5 py-2.5 font-mono text-xs">
                  {open}
                </div>
                <ol
                  ref={code}
                  className="relative min-h-0 flex-1 overflow-y-auto py-3 font-mono text-sm leading-relaxed"
                >
                  {lines.map((line, i) => (
                    <li
                      key={`${open}-${i}`}
                      data-line={i + 1}
                      className={cn(
                        'duration-slower flex gap-5 border-l-2 border-transparent px-5 whitespace-pre transition-[opacity,background-color,border-color] ease-out',
                        focused && (i + 1 < focused.from || i + 1 > focused.to) && 'opacity-35',
                        focused &&
                          i + 1 >= focused.from &&
                          i + 1 <= focused.to &&
                          'bg-muted/60 border-foreground',
                      )}
                    >
                      <span className="text-muted-foreground w-6 shrink-0 text-right tabular-nums select-none">
                        {i + 1}
                      </span>
                      <span>
                        <Line path={open} line={line} inFrontmatter={i > 0 && i < fenceEnd} />
                      </span>
                    </li>
                  ))}
                </ol>
                <div className="flex flex-col gap-1 border-t px-5 py-3 font-mono text-sm">
                  <div className="flex items-center gap-2">
                    <TerminalIcon className="text-muted-foreground size-4" aria-hidden />
                    <span className="text-muted-foreground select-none">$</span>
                    <span>kortix ship</span>
                  </div>
                  {shipped ? <ShipOutput /> : null}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
