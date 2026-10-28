import { useTranslations } from '@/i18n/use-translations';
import { cn } from '@kortix/ui';
import type { ReactNode } from 'react';

/*
 * The /self-hosted product frames (the /sovereign shapes, kept local so the
 * pages can change apart). Lines wrap instead of scrolling, so a long command
 * stays readable at 390 px.
 */

/** A window with a title bar: the frame every hero step and terminal tab uses. */
export function Window({
  title,
  children,
  className,
}: {
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'bg-background flex min-w-0 flex-1 flex-col overflow-hidden rounded-lg border',
        className,
      )}
    >
      <div className="flex items-center gap-3 border-b px-4 py-3">
        <span aria-hidden className="flex items-center gap-1.5">
          <span className="bg-muted-foreground/40 size-2.5 rounded-full" />
          <span className="bg-muted-foreground/40 size-2.5 rounded-full" />
          <span className="bg-muted-foreground/40 size-2.5 rounded-full" />
        </span>
        <span className="text-muted-foreground min-w-0 truncate font-mono text-xs">{title}</span>
      </div>
      {children}
    </div>
  );
}

/**
 * Shell lines: `$` starts a command, `#` a comment, `✓` a success line, and
 * anything else is output. An empty string is a blank line.
 */
export function Terminal({ lines, className }: { lines: readonly string[]; className?: string }) {
  const tMarketing = useTranslations('hardcodedUi.i18nComplete');

  return (
    <pre
      className={cn(
        'font-mono text-xs leading-6 whitespace-pre-wrap sm:text-sm sm:leading-7',
        className,
      )}
    >
      <code className="flex flex-col">
        {lines.map((line, i) => {
          // A fixed snippet: the index is the identity of the line.
          const key = `${i}-${line}`;
          if (line === '') return <span key={key}>{'\u00a0'}</span>;
          if (line.startsWith('#')) {
            return (
              <span key={key} className="text-muted-foreground">
                {line}
              </span>
            );
          }
          if (line.startsWith('$')) {
            return (
              <span key={key} className="text-foreground pl-4 -indent-4 wrap-break-word">
                <span className="text-muted-foreground select-none">$ </span>
                {line.slice(2)}
              </span>
            );
          }
          if (line.startsWith('✓')) {
            return (
              <span key={key} className="text-foreground pl-4 -indent-4 wrap-break-word">
                <span className="text-kortix-green">✓</span>
                {line.slice(1)}
              </span>
            );
          }
          return (
            <span key={key} className="text-muted-foreground pl-4 -indent-4 wrap-break-word">
              {line}
            </span>
          );
        })}
      </code>
    </pre>
  );
}
