'use client';

import { CheckCircleIcon, InfoIcon, WarningIcon } from '@phosphor-icons/react';

import { MarkdownImage, MarkdownLink } from '@/components/markdown/unified-markdown';
import { InfoBanner } from '@/components/ui/info-banner';
import { StatusBadge } from '@/components/ui/status';

import type { GenuiComponentProps } from '../sdk';

// An informational chip: the hue is the /15 tint, the label stays ink (color.md D5). Neutral takes no hue.
const BADGE_TONE = { neutral: 'neutral', good: 'success', warn: 'warning', bad: 'destructive' } as const;
const CALLOUT = {
  info: { tone: 'info', icon: InfoIcon },
  warn: { tone: 'warning', icon: WarningIcon },
  success: { tone: 'success', icon: CheckCircleIcon },
} as const;

export function GenuiBadge({ props }: GenuiComponentProps) {
  return <StatusBadge tone={BADGE_TONE[(props.tone ?? 'neutral') as keyof typeof BADGE_TONE]}>{props.label}</StatusBadge>;
}

export function GenuiCallout({ props }: GenuiComponentProps) {
  const callout = CALLOUT[props.tone as keyof typeof CALLOUT] ?? CALLOUT.info;
  return (
    <InfoBanner tone={callout.tone} icon={callout.icon} title={props.title || undefined}>
      {props.body}
    </InfoBanner>
  );
}

export function GenuiImage({ props }: GenuiComponentProps) {
  return (
    <figure className="flex flex-col gap-1">
      <MarkdownImage src={props.src} alt={props.alt} flush />
      {props.caption ? <figcaption className="text-muted-foreground text-xs text-pretty">{props.caption}</figcaption> : null}
    </figure>
  );
}

export function GenuiLink({ props }: GenuiComponentProps) {
  return <MarkdownLink href={props.href}>{props.label}</MarkdownLink>;
}
