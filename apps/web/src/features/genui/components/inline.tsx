'use client';

import { CheckCircleIcon, InfoIcon, WarningIcon } from '@phosphor-icons/react';

import { MarkdownImage, MarkdownLink } from '@/components/markdown/unified-markdown';
import { Badge } from '@/components/ui/badge';
import { InfoBanner } from '@/components/ui/info-banner';

import type { GenuiComponentProps } from '../sdk';

// One hue per state (color.md D5): good = green, warn = orange, bad = red. Neutral takes no hue.
const BADGE_VARIANT = { neutral: 'default', good: 'success', warn: 'warning', bad: 'destructive' } as const;
const CALLOUT = {
  info: { tone: 'info', icon: InfoIcon },
  warn: { tone: 'warning', icon: WarningIcon },
  success: { tone: 'success', icon: CheckCircleIcon },
} as const;

export function GenuiBadge({ props }: GenuiComponentProps) {
  return <Badge variant={BADGE_VARIANT[(props.tone ?? 'neutral') as keyof typeof BADGE_VARIANT]}>{props.label}</Badge>;
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
      <MarkdownImage src={props.src} alt={props.alt} />
      {props.caption ? <figcaption className="text-muted-foreground text-xs text-pretty">{props.caption}</figcaption> : null}
    </figure>
  );
}

export function GenuiLink({ props }: GenuiComponentProps) {
  return <MarkdownLink href={props.href}>{props.label}</MarkdownLink>;
}
