import { createContext, useContext } from 'react';
import { Pressable, View } from 'react-native';
import { useColorScheme } from 'nativewind';
import { useTranslation } from 'react-i18next';
import type { GenuiComponentProps } from '@kortix/sdk/genui/react';

import { MarkdownImage, type MarkdownImageLook } from '@/components/markdown/markdown-image';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { ArrowUpRightIcon, CheckCircleIcon, InfoIcon, WarningIcon } from '@/lib/icons';
import { TYPE } from '@/lib/markdown/markdown-layout';

import { openGenuiLink } from './open-link';

// As web: the tone paints only the /15 tint; the label stays ink, so it passes WCAG AA on every tint.
// Neutral is the secondary well. The dot is the single Card's badge pill.
const BADGE_TONE = {
  neutral: { well: 'bg-secondary', dot: 'bg-muted-foreground' },
  good: { well: 'bg-kortix-green/15', dot: 'bg-kortix-green' },
  warn: { well: 'bg-kortix-orange/15', dot: 'bg-kortix-orange' },
  bad: { well: 'bg-kortix-red/15', dot: 'bg-kortix-red' },
} as const;

export const badgeTone = (tone: unknown) => BADGE_TONE[(tone ?? 'neutral') as keyof typeof BADGE_TONE] ?? BADGE_TONE.neutral;

// Web's Paper Callout 14: the tone is the /15 well and the solid glyph; title and body stay ink.
const CALLOUT = {
  info: { icon: InfoIcon, well: 'bg-kortix-blue/15', glyph: 'text-kortix-blue' },
  warn: { icon: WarningIcon, well: 'bg-kortix-orange/15', glyph: 'text-kortix-orange' },
  success: { icon: CheckCircleIcon, well: 'bg-kortix-green/15', glyph: 'text-kortix-green' },
} as const;

export function GenuiBadge({ props }: GenuiComponentProps) {
  const tone = badgeTone(props.tone);
  return (
    <View className={`self-start rounded-md px-2 py-0.5 ${tone.well}`}>
      <Text variant="small" className="leading-5 text-foreground">
        {props.label}
      </Text>
    </View>
  );
}

export function GenuiCallout({ props }: GenuiComponentProps) {
  const callout = CALLOUT[props.tone as keyof typeof CALLOUT] ?? CALLOUT.info;
  return (
    <View className={`flex-row gap-2.5 rounded-xl px-3.5 py-2.5 ${callout.well}`}>
      {/* mt-0.5 centers the 16pt glyph on the first 20pt line, of the title or of the body. */}
      <Icon as={callout.icon} size={16} weight="fill" className={`mt-0.5 ${callout.glyph}`} />
      <View className="flex-1">
        {/* Web sets the title at 550; mobile ships static Roobert faces, so Medium (500) is the nearest. */}
        {props.title ? (
          <Text style={TYPE.sm} className="font-medium">
            {props.title}
          </Text>
        ) : null}
        <Text style={TYPE.sm}>{props.body}</Text>
      </View>
    </View>
  );
}

/**
 * The markdown image: the same frame, failure state, and remote-image policy as an image in the message text
 * (`MarkdownImagesContext`: loads in an agent reply, a placeholder card elsewhere).
 */
export function GenuiImageView({ src, alt, fixedHeight, look }: { src: string; alt: string; fixedHeight?: number; look?: MarkdownImageLook }) {
  const { colorScheme } = useColorScheme();
  return <MarkdownImage src={src} alt={alt} isDark={colorScheme === 'dark'} fixedHeight={fixedHeight} look={look} />;
}

/** Set inside an image gallery (layout.tsx): each `page` fits the gallery's fixed page height. */
export const GenuiImageGridContext = createContext<false | 'page'>(false);

/** Every gallery page is this tall, as the markdown gallery's (`markdown-image.tsx`); each image fits inside it. */
export const GALLERY_PAGE_HEIGHT = 280;

/** The picture of an Image with text is this wide; the text takes the rest of the row. */
const FIGURE_WIDTH = 112;

/**
 * Paper Image 3F0H: the image in a dark letterbox well (the terminal surface in both themes, so a photo reads
 * the same on light and dark), its caption as a chip over the bottom-left, and an open button top-right.
 * Phones have no hover, so the button always shows.
 */
export function GenuiImage({ props }: GenuiComponentProps) {
  const { t } = useTranslation();
  const page = useContext(GenuiImageGridContext) === 'page';
  // An image with text is a figure: the picture beside the sentences that say what to look for in it.
  if (props.text && !page) {
    return (
      <View className="flex-row items-start gap-3">
        <View style={{ width: FIGURE_WIDTH }} className="overflow-hidden rounded-lg bg-secondary">
          <GenuiImageView src={props.src} alt={props.alt} />
        </View>
        <Text style={TYPE.sm} className="flex-1">
          {props.text}
        </Text>
      </View>
    );
  }
  return (
    <View className="overflow-hidden rounded-xl bg-terminal-surface">
      <GenuiImageView src={props.src} alt={props.alt} fixedHeight={page ? GALLERY_PAGE_HEIGHT : undefined} />
      <View className="absolute right-2.5 top-2.5">
        <Button
          variant="secondary"
          size="icon-sm"
          className="rounded-md"
          accessibilityLabel={t('genui.openImage', 'Open image')}
          onPress={() => openGenuiLink(props.src)}
        >
          <Icon as={ArrowUpRightIcon} size={14} />
        </Button>
      </View>
      {props.caption ? (
        <View className="absolute bottom-2.5 left-2.5 max-w-[85%] rounded-md bg-terminal-surface/80 px-2 py-1">
          <Text variant="small" numberOfLines={1} className="leading-5 text-terminal-fg">
            {props.caption}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

export function GenuiLink({ props }: GenuiComponentProps) {
  return (
    <Pressable
      accessibilityRole="link"
      hitSlop={8}
      className="self-start active:opacity-70"
      onPress={() => openGenuiLink(props.href)}
    >
      <Text className="underline">{props.label}</Text>
    </Pressable>
  );
}
