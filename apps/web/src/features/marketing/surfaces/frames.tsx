import { cn } from '@kortix/ui';
import { MicrophoneIcon } from '@phosphor-icons/react/dist/ssr';
import type { ReactNode } from 'react';

/*
 * The devices the surface pages draw: a desktop window, a phone and a
 * terminal. Hairlines, never shadows. Every frame is drawn in tokens, so it
 * follows the visitor's theme, and every one reflows to 390 px instead of
 * scaling down: text stays at its real size.
 */

/** Neutral window dots. Not the macOS colours: the page spends no decorative colour. */
export function WindowDots() {
  return (
    <span aria-hidden className="flex gap-1.5">
      <span className="bg-border size-2.5 rounded-full" />
      <span className="bg-border size-2.5 rounded-full" />
      <span className="bg-border size-2.5 rounded-full" />
    </span>
  );
}

/** A native desktop window: the title bar, then the app. */
export function DesktopFrame({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="bg-background w-full overflow-hidden rounded-lg border">
      <div className="flex items-center gap-4 border-b px-4 py-2.5">
        <WindowDots />
        <span className="text-muted-foreground flex-1 truncate text-center text-xs">{title}</span>
        <span aria-hidden className="w-12" />
      </div>
      {children}
    </div>
  );
}

/** A whole phone: status bar, the session's title bar, the screen, the composer. */
export function PhoneFrame({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div /* audit:allow device art: a phone body, no UI radius token draws one */ className="bg-background border-border relative h-[36rem] w-80 max-w-full shrink-0 overflow-hidden rounded-[2.75rem] border p-2">
      <div /* audit:allow device art: the screen, concentric with the body (2.75rem minus the 0.5rem bezel) */ className="border-border flex h-full flex-col overflow-hidden rounded-[2.25rem] border">
        <div className="flex items-center justify-between px-6 pt-3.5 pb-2">
          <span className="text-foreground text-xs font-medium tabular-nums">9:41</span>
          <span aria-hidden className="bg-foreground h-6 w-20 rounded-full" />
          <span aria-hidden className="flex items-center gap-1">
            <span className="bg-foreground h-2 w-3 rounded-xs" />
            <span className="bg-foreground h-2.5 w-5 rounded-xs" />
          </span>
        </div>
        <div className="flex items-center justify-between border-b px-4 py-3">
          <span aria-hidden className="flex flex-col gap-1">
            <span className="bg-foreground h-px w-4" />
            <span className="bg-foreground h-px w-3" />
            <span className="bg-foreground h-px w-4" />
          </span>
          <span className="text-foreground truncate px-3 text-sm font-medium">{title}</span>
          <span aria-hidden className="text-muted-foreground text-sm leading-none">
            ···
          </span>
        </div>
        <div className="flex min-h-0 flex-1 flex-col justify-end gap-4 overflow-hidden px-4 pt-4 pb-3">{children}</div>
        <div className="px-3 pb-3">
          <div className="text-muted-foreground flex items-center justify-between rounded-lg border px-3 py-2.5 text-sm">
            Ask anything…
            <MicrophoneIcon aria-hidden className="size-4" />
          </div>
        </div>
        <span aria-hidden className="bg-foreground mx-auto mb-2 h-1 w-28 rounded-full" />
      </div>
    </div>
  );
}

export type TerminalLine =
  | { kind: 'cmd'; text: string }
  | { kind: 'out'; text: string }
  /** A table row: never wraps; the terminal scrolls sideways instead. */
  | { kind: 'row'; text: string }
  | { kind: 'ok'; text: string }
  | { kind: 'note'; text: string }
  | { kind: 'gap' };

/**
 * A terminal: commands after a muted prompt, output under them, `#` notes
 * muted. Long lines wrap as a real terminal does, so nothing is cut at 390 px.
 */
export function TerminalFrame({
  title,
  lines,
  size = 'lg',
}: {
  title: string;
  lines: readonly TerminalLine[];
  size?: 'lg' | 'sm';
}) {
  return (
    <div className="bg-background w-full overflow-hidden rounded-lg border">
      <div className="flex items-center gap-4 border-b px-4 py-2.5">
        <WindowDots />
        <span className="text-muted-foreground flex-1 truncate text-center font-mono text-xs">{title}</span>
        <span aria-hidden className="w-12" />
      </div>
      <pre
        className={cn(
          'overflow-x-auto font-mono break-words whitespace-pre-wrap',
          size === 'lg' ? 'px-4 py-5 text-xs leading-6 sm:px-6 sm:text-sm sm:leading-7' : 'px-4 py-4 text-xs leading-6',
        )}
      >
        {lines.map((line, i) =>
          line.kind === 'gap' ? (
            <span key={i} className="block h-3" />
          ) : (
            <span
              key={i}
              className={cn(
                'block',
                (line.kind === 'cmd' || line.kind === 'ok') && 'text-foreground',
                line.kind === 'out' && 'text-muted-foreground pl-4',
                line.kind === 'row' && 'text-muted-foreground w-max pl-4 whitespace-pre',
                line.kind === 'ok' && 'pl-4',
                line.kind === 'note' && 'text-muted-foreground',
              )}
            >
              {line.kind === 'cmd' ? <span className="text-muted-foreground select-none">$ </span> : null}
              {line.kind === 'ok' ? <span className="text-kortix-green select-none">✓ </span> : null}
              {line.kind === 'note' ? <span className="select-none"># </span> : null}
              {line.text}
            </span>
          ),
        )}
      </pre>
    </div>
  );
}
