/**
 * One web source, flat: favicon → title → domain.
 *
 * Mirrors apps/web `tool/shared/web-source-row.tsx`: `flex items-center
 * gap-2.5 rounded-sm px-2 py-2`; `FaviconAvatar size="xs"` (a `size-4`
 * `bg-muted/60 rounded` tile, `Globe` fallback); title `text-sm
 * text-foreground` truncating; domain `text-sm text-muted-foreground` capped
 * at 40%. A safe http(s) URL opens externally on tap (web `<a
 * target="_blank">`, pressed tint `bg-muted`); anything else is a plain row.
 */

import { useState } from 'react';
import { Image, Pressable, View } from 'react-native';
import { wsDomain, wsFavicon } from '@kortix/sdk';
import { Text } from '@/components/ui/text';
import { GlobeIcon } from '@/lib/icons';
import { webSpace } from '@/lib/session/user-message';
import { TURN_SPACE, TURN_TYPE, useTurnPalette } from './styles';
import { useToolNavigation } from './navigation';

function safeHttpUrl(url: string): string | null {
  const trimmed = url.trim();
  return /^https?:\/\/[^\s]+$/i.test(trimmed) ? trimmed : null;
}

/** Web `FaviconAvatar size="xs"`. */
export function FaviconAvatar({ value }: { value: string }) {
  const palette = useTurnPalette();
  const [failed, setFailed] = useState(false);
  const favicon = safeHttpUrl(value) ? wsFavicon(value) : null;
  const size = TURN_SPACE.icon;
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: 4,
        backgroundColor: palette.muted60Bg,
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
        flexShrink: 0,
      }}
    >
      {favicon && !failed ? (
        <Image source={{ uri: favicon }} style={{ width: size, height: size }} onError={() => setFailed(true)} />
      ) : (
        <GlobeIcon size={webSpace(3)} color={palette.muted50} />
      )}
    </View>
  );
}

export function WebSourceRow({ url, title }: { url: string; title: string }) {
  const palette = useTurnPalette();
  const { openExternal } = useToolNavigation();
  const safe = safeHttpUrl(url);
  const domain = safe ? wsDomain(safe) : '';

  const inner = (
    <>
      <FaviconAvatar value={safe ?? title} />
      <Text variant="muted" numberOfLines={1} style={[TURN_TYPE.sm, { flex: 1, minWidth: 0, color: palette.foreground }]}>
        {title}
      </Text>
      {domain ? (
        <Text
          variant="muted"
          numberOfLines={1}
          style={[TURN_TYPE.sm, { maxWidth: '40%', flexShrink: 0, color: palette.mutedForeground }]}
        >
          {domain}
        </Text>
      ) : null}
    </>
  );

  const row = {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: webSpace(2.5),
    borderRadius: 4,
    paddingHorizontal: webSpace(2),
    paddingVertical: webSpace(2),
  };

  if (!safe) return <View style={row}>{inner}</View>;
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={title}
      onPress={() => openExternal(safe)}
      style={({ pressed }) => [row, pressed && { backgroundColor: palette.muted }]}
    >
      {inner}
    </Pressable>
  );
}
