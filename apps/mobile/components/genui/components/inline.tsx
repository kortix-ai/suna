import { Pressable, View } from 'react-native';
import { useColorScheme } from 'nativewind';
import type { GenuiComponentProps } from '@kortix/sdk/genui/react';

import { MarkdownImage } from '@/components/markdown/markdown-image';
import { Badge } from '@/components/ui/badge';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { CheckCircleIcon, InfoIcon, WarningIcon } from '@/lib/icons';

import { openGenuiLink } from './open-link';

const BADGE_VARIANT = { neutral: 'secondary', good: 'default', warn: 'outline', bad: 'destructive' } as const;
const CALLOUT_ICON = { info: InfoIcon, warn: WarningIcon, success: CheckCircleIcon } as const;

export function GenuiBadge({ props }: GenuiComponentProps) {
  return (
    <Badge variant={BADGE_VARIANT[(props.tone ?? 'neutral') as keyof typeof BADGE_VARIANT]}>
      <Text>{props.label}</Text>
    </Badge>
  );
}

export function GenuiCallout({ props }: GenuiComponentProps) {
  const icon = CALLOUT_ICON[props.tone as keyof typeof CALLOUT_ICON] ?? InfoIcon;
  return (
    <View className="flex-row gap-3 rounded-2xl bg-secondary px-4 py-3">
      <Icon as={icon} size={18} className="mt-0.5 text-foreground" />
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
        <Text variant="muted" className="text-xs">
          {props.caption}
        </Text>
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
