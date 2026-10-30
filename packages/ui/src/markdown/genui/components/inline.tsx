'use client';

import { ArrowUpRightIcon, CheckCircleIcon, InfoIcon, WarningIcon } from '@phosphor-icons/react';
import { createContext, useContext } from 'react';

import { MarkdownImage, MarkdownLink } from '../../unified-markdown';
import { useTranslations } from '../../../i18n';
import { cn } from '../../../lib/utils';

import type { GenuiComponentProps } from '../sdk';

// An informational chip: the hue is the /15 tint, the label stays ink (color.md D5).
export const BADGE_TONE = { neutral: 'neutral', good: 'success', warn: 'warning', bad: 'destructive' } as const;
export type BadgeTone = (typeof BADGE_TONE)[keyof typeof BADGE_TONE];
// Paper Callout 14 (semibold title): the tone is the /15 fill and the solid 16px glyph; title and body stay ink (D5).
const CALLOUT = {
  info: { icon: InfoIcon, well: 'bg-kortix-blue/15', glyph: 'text-kortix-blue' },
  warn: { icon: WarningIcon, well: 'bg-kortix-orange/15', glyph: 'text-kortix-orange' },
  success: { icon: CheckCircleIcon, well: 'bg-kortix-green/15', glyph: 'text-kortix-green' },
} as const;

export const badgeTone = (tone: unknown): BadgeTone => BADGE_TONE[(tone ?? 'neutral') as keyof typeof BADGE_TONE] ?? 'neutral';

// The tone paints the /15 tint; the 12px label stays ink, as GenuiCallout does (D5): an accent never paints text.
const BADGE_CLASS: Record<BadgeTone, string> = {
  neutral: 'bg-muted text-foreground',
  success: 'bg-kortix-green/15 text-foreground',
  warning: 'bg-kortix-orange/15 text-foreground',
  destructive: 'bg-kortix-red/15 text-foreground',
};

/** The badge's classes, for a host chip that must look exactly like a genui badge. */
export const genuiBadgeClass = (tone: BadgeTone) =>
  cn('inline-flex w-fit items-center rounded-md px-2 py-0.5 text-xs font-medium whitespace-nowrap', BADGE_CLASS[tone]);

export function GenuiBadge({ props }: GenuiComponentProps) {
  return (
    <span className={genuiBadgeClass(badgeTone(props.tone))}>
      {props.label}
    </span>
  );
}

export function GenuiCallout({ props }: GenuiComponentProps) {
  const callout = CALLOUT[props.tone as keyof typeof CALLOUT] ?? CALLOUT.info;
  return (
    <div role="note" className={cn('flex gap-2.5 rounded-lg px-3.5 py-2.5', callout.well)}>
      {/* mt-0.5 centers the 16px glyph on the first 20px line, of the title or of the body. */}
      <callout.icon className={cn('mt-0.5 size-4 shrink-0', callout.glyph)} weight="fill" aria-hidden />
      <div className="flex min-w-0 flex-col text-sm">
        {props.title ? <span className="text-foreground font-[550]">{props.title}</span> : null}
        <p className="text-foreground text-pretty">{props.body}</p>
      </div>
    </div>
  );
}

/** Set inside an image gallery (layout.tsx): the tile sizes the image, which covers it. A `tile` shows its caption on hover. */
export const GenuiImageGridContext = createContext<false | 'lead' | 'tile'>(false);

const IMAGE_CONTROL =
  'bg-background/90 text-foreground hover:bg-background duration-fast flex size-7 items-center justify-center rounded-md transition-colors';

export function GenuiImage({ props }: GenuiComponentProps) {
  const t = useTranslations('genui');
  const inGrid = useContext(GenuiImageGridContext);
  const src = String(props.src);
  // An image with text is a figure: the picture beside the sentences that say what to look for in it.
  if (props.text && !inGrid) {
    return (
      <figure className="flex items-start gap-4">
        <span className="bg-muted w-28 shrink-0 overflow-hidden rounded-lg sm:w-40 [&_img]:w-full [&_img]:rounded-none [&_img]:outline-0 [&>span]:block">
          <MarkdownImage src={src} alt={props.alt} flush />
        </span>
        <figcaption className="text-foreground min-w-0 text-sm text-pretty">{props.text}</figcaption>
      </figure>
    );
  }
  return (
    <figure
      className={cn(
        // A single image sits in the terminal surface in both themes: a photo reads the same on light and
        // dark. A gallery tile takes the muted well, so a transparent product shot is not boxed in black.
        'group/image relative flex items-center justify-center overflow-hidden rounded-lg',
        inGrid ? 'bg-muted' : 'bg-terminal-surface',
        '[&_img]:rounded-none [&_img]:outline-0',
        inGrid ? 'size-full [&>span]:size-full [&_img]:size-full [&_img]:object-cover' : 'max-h-[420px] [&_img]:max-h-[420px] [&_img]:w-auto',
      )}
    >
      <MarkdownImage src={src} alt={props.alt} flush />
      {/* Opens the full image in a new tab: the browser is the lightbox. */}
      <div className="absolute top-2.5 right-2.5 flex gap-1.5 opacity-0 transition-opacity group-focus-within/image:opacity-100 group-hover/image:opacity-100">
        <a href={src} target="_blank" rel="noopener noreferrer" className={IMAGE_CONTROL} aria-label={t('openImage')}>
          <ArrowUpRightIcon className="size-3.5" aria-hidden />
        </a>
      </div>
      {props.caption ? (
        <figcaption
          className={cn(
            'bg-terminal-surface/80 text-terminal-fg absolute bottom-2.5 left-2.5 max-w-[calc(100%-1.25rem)] truncate rounded-md px-2 py-1 text-xs',
            // A gallery tile shows its caption on hover or focus; the lead and a single image always show theirs.
            inGrid === 'tile' && 'opacity-0 transition-opacity group-focus-within/image:opacity-100 group-hover/image:opacity-100',
          )}
          title={String(props.caption)}
        >
          {props.caption}
        </figcaption>
      ) : null}
    </figure>
  );
}

export function GenuiLink({ props }: GenuiComponentProps) {
  return <MarkdownLink href={props.href}>{props.label}</MarkdownLink>;
}
