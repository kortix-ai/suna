import { Pressable, View } from 'react-native';
import { useColorScheme } from 'nativewind';
import type { GenuiComponentProps } from '@kortix/sdk/genui/react';

import { MarkdownImage } from '@/components/markdown/markdown-image';
import { StatusChip } from '@/components/kortix/status-chip';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { CheckCircleIcon, InfoIcon, WarningIcon } from '@/lib/icons';

import { openGenuiLink } from './open-link';

// An informational chip, as on web: the hue is the /15 tint, the label stays ink.
const BADGE_TONE = { neutral: 'neutral', good: 'success', warn: 'warning', bad: 'destructive' } as const;
// Web's toned InfoBanner: a /15 tint per tone, ink icon and text.
const CALLOUT = {
  info: { icon: InfoIcon, tint: 'bg-kortix-blue/15' },
  warn: { icon: WarningIcon, tint: 'bg-kortix-orange/15' },
  success: { icon: CheckCircleIcon, tint: 'bg-kortix-green/15' },
} as const;

export function GenuiBadge({ props }: GenuiComponentProps) {
  return <StatusChip tone={BADGE_TONE[(props.tone ?? 'neutral') as keyof typeof BADGE_TONE]}>{props.label}</StatusChip>;
}

export function GenuiCallout({ props }: GenuiComponentProps) {
  const callout = CALLOUT[props.tone as keyof typeof CALLOUT] ?? CALLOUT.info;
  return (
    <View className={`flex-row gap-3 rounded-2xl px-4 py-3 ${callout.tint}`}>
      <Icon as={callout.icon} size={18} className="mt-0.5 text-foreground" />
      <View className="flex-1 gap-0.5">
        {props.title ? <Text className="font-medium">{props.title}</Text> : null}
        <Text>{props.body}</Text>
      </View>
    </View>
  );
}

/**
 * The markdown image: the same frame, failure state, and remote-image policy as an image in the message text
 * (`MarkdownImagesContext`: loads in an agent reply, a placeholder card elsewhere).
 */
export function GenuiImageView({ src, alt }: { src: string; alt: string }) {
  const { colorScheme } = useColorScheme();
  return <MarkdownImage src={src} alt={alt} isDark={colorScheme === 'dark'} />;
}

export function GenuiImage({ props }: GenuiComponentProps) {
  return (
    <View className="gap-1">
      <GenuiImageView src={props.src} alt={props.alt} />
      {props.caption ? (
        <Text variant="muted">{props.caption}</Text>
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
