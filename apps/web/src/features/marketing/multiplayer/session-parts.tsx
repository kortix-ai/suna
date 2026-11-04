import { useTranslations } from '@/i18n/use-translations';
import { cn } from '@kortix/ui';
import Loading from '@kortix/ui/loading';
import type { Icon } from '@phosphor-icons/react';
import { ShieldCheckIcon, ShieldWarningIcon } from '@phosphor-icons/react/dist/ssr';
import type { ReactNode } from 'react';

/*
 * Thread parts for the /multiplayer visuals, drawn from the product's session
 * parts: the member author above a message (session/participants), the chain
 * of tool steps (turn/activity-step.tsx) and the approval prompt
 * (prompts/session-permission-prompt.tsx). Pictures, not controls: nothing
 * here is focusable. Sample data is fictional: Arcadia, Member N.
 */

/** Opacity only, so reduced motion needs no variant (motion.md). */
export const FADE = 'animate-in fade-in duration-slower ease-out';

export function Initials({ label, className }: { label: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'bg-foreground text-background ring-background flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-medium tracking-tight ring-2',
        className,
      )}
    >
      {label}
    </span>
  );
}

/** A sent message, right-aligned; with an author, their initials and name above it. */
export function Prompt({
  author,
  children,
  className,
}: {
  author?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col items-end gap-1.5', className)}>
      {author ? (
        <span className="text-muted-foreground flex items-center gap-1.5 text-xs font-medium">
          <Initials label={author.replace('Member ', 'M')} className="size-6 ring-0" />
          {author}
        </span>
      ) : null}
      <p className="bg-secondary text-foreground max-w-[85%] rounded-lg px-3.5 py-2.5 text-sm text-pretty">
        {children}
      </p>
    </div>
  );
}

export function Reply({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn('text-foreground text-sm text-pretty', className)}>{children}</p>;
}

/** A centred hairline label: a change to who is in the session. */
export function Divider({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('text-muted-foreground flex items-center gap-3 text-xs', className)}>
      <span className="bg-border h-px flex-1" />
      <span className="text-center">{children}</span>
      <span className="bg-border h-px flex-1" />
    </div>
  );
}

/** A run of tool steps on one rail through their icons. */
export function Chain({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <ol className={cn('relative flex flex-col gap-2', className)}>
      <span aria-hidden className="bg-border absolute top-2 bottom-2 left-2 w-px" />
      {children}
    </ol>
  );
}

export function StepRow({
  icon: Glyph,
  verb,
  object,
  running,
  className,
}: {
  icon: Icon;
  verb: string;
  object: string;
  running?: boolean;
  className?: string;
}) {
  return (
    <li className={cn('relative flex min-w-0 items-center gap-2.5 text-sm', className)}>
      <span className="bg-background text-muted-foreground flex size-4 flex-none items-center justify-center">
        {running ? <Loading className="size-3.5" /> : <Glyph className="size-4" aria-hidden />}
      </span>
      <span className="text-foreground flex-none">{verb}</span>
      <span className="text-muted-foreground min-w-0 truncate font-mono text-xs">{object}</span>
    </li>
  );
}

/** The held connector call: Ask until a person decides, then the record of who did. */
export function ApprovalCard({
  approved,
  call,
  summary,
  by,
  className,
}: {
  approved: boolean;
  call: string;
  summary: string;
  by: string;
  className?: string;
}) {
  const tMarketing = useTranslations('hardcodedUi.i18nComplete');

  return (
    <div className={cn('bg-popover overflow-hidden rounded-lg border', className)}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b px-3 py-2">
        {approved ? (
          <ShieldCheckIcon className="text-kortix-green size-4 shrink-0" aria-hidden />
        ) : (
          <ShieldWarningIcon className="text-kortix-orange size-4 shrink-0" aria-hidden />
        )}
        <span className="text-foreground text-xs font-medium">
          {approved ? 'Approved' : tMarketing('text9928dd82f38f')}
        </span>
        <span className="text-muted-foreground text-xs">
          {approved ? by : tMarketing('texta31c526d967c')}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-3 px-3 py-2.5">
        <span className="flex min-w-0 flex-1 basis-40 flex-col gap-0.5">
          <span className="text-foreground font-mono text-xs">{call}</span>
          <span className="text-muted-foreground text-xs text-pretty">{summary}</span>
        </span>
        {approved ? null : (
          <span className="flex items-center gap-1.5">
            <span className="text-foreground rounded-md border px-2.5 py-1 text-xs font-medium">
              {tMarketing('text05a2d7332eb9')}
            </span>
            <span className="bg-foreground text-background rounded-md px-2.5 py-1 text-xs font-medium">
              {tMarketing('text6007acbe30b2')}
            </span>
          </span>
        )}
      </div>
    </div>
  );
}

/** Hue only on a mark that reports a state; the word carries the meaning. */
const VERDICT = {
  allow: { dot: 'bg-kortix-green', tint: 'bg-kortix-green/15' },
  ask: { dot: 'bg-kortix-yellow', tint: 'bg-kortix-yellow/15' },
  block: { dot: 'bg-kortix-red', tint: 'bg-kortix-red/15' },
} as const;

export function Verdict({ kind, label }: { kind: keyof typeof VERDICT; label: string }) {
  const tone = VERDICT[kind];
  return (
    <span
      className={cn(
        'text-foreground inline-flex shrink-0 items-center gap-1.5 rounded-sm px-2 py-0.5 text-sm font-medium',
        tone.tint,
      )}
    >
      <span aria-hidden className={cn('size-1.5 rounded-full', tone.dot)} />
      {label}
    </span>
  );
}
