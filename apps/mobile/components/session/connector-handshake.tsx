/**
 * Kortix · · · App — web's `ConnectorHandshake`
 * (`apps/web/src/components/setup-links/connector-handshake.tsx`).
 *
 * `ConnectorAppMark` is the app's tile: its logo, a skeleton while the logo is
 * not known yet, or the app's first letter. It leads the in-chat connect row.
 * Web drops the Kortix tile and the bridge on a card narrower than 28rem, which
 * is every phone, so the row shows the app mark alone there too.
 *
 * `ConnectorHandshake` is the pair joined by the dotted bridge. It heads the
 * connect sheets, as it heads web's connect dialog.
 */
import * as React from 'react';
import { Image, View } from 'react-native';
import Svg, { Circle, SvgUri } from 'react-native-svg';
import { useColorScheme } from 'nativewind';

import { KortixLogo } from '@/components/kortix/KortixLogo';
import { SheetBody } from '@/components/kortix/sheet';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { ArrowUpRightIcon, CheckIcon, PlugIcon } from '@/lib/icons';
import { THEME } from '@/lib/utils/theme';

export interface ConnectorAppMarkProps {
  name: string;
  /** `undefined` while loading (skeleton), `null` when the app has no logo. */
  iconUrl: string | null | undefined;
  size: number;
  radius: number;
  /** A green check on the tile's corner. The ring takes the row's `card` fill. */
  connected?: boolean;
}

/** Composio serves every catalogue logo as SVG from an extension-less URL. */
const SVG_LOGO = /\.svg(?:[?#]|$)|^https:\/\/logos\.composio\.dev\//i;

export function ConnectorAppMark({ name, iconUrl, size, radius, connected = false }: ConnectorAppMarkProps) {
  // React Native's `Image` decodes no SVG, and most catalogue logos are SVG.
  // A logo `Image` rejects gets one more attempt as SVG before the monogram.
  const [failed, setFailed] = React.useState<{ url: string; as: 'image' | 'svg' } | null>(null);
  const failure = failed && failed.url === iconUrl ? failed.as : null;
  const asSvg = !!iconUrl && (SVG_LOGO.test(iconUrl) || failure === 'image');
  const broken = failure === 'svg';
  const svgFailed = React.useCallback(() => setFailed(iconUrl ? { url: iconUrl, as: 'svg' } : null), [iconUrl]);

  const box = { width: size, height: size, borderRadius: radius };
  const letter = name.trim().charAt(0).toUpperCase();

  let tile: React.ReactNode;
  if (iconUrl === undefined) {
    tile = <Skeleton style={box} />;
  } else if (!iconUrl || broken) {
    tile = (
      <View className="items-center justify-center bg-secondary" style={box}>
        {letter ? (
          <Text className="text-muted-foreground" style={{ fontSize: size * 0.4, lineHeight: size * 0.5 }}>
            {letter}
          </Text>
        ) : (
          <Icon as={PlugIcon} size={size * 0.45} className="text-muted-foreground" />
        )}
      </View>
    );
  } else {
    tile = (
      // White in both themes: catalogue logos are drawn for a white ground, and
      // a black glyph (GitHub, Notion, Linear) disappears on the dark surface.
      <View className="overflow-hidden bg-white" style={box}>
        {asSvg ? (
          <SvgUri uri={iconUrl} width={size} height={size} onError={svgFailed} />
        ) : (
          <Image
            source={{ uri: iconUrl }}
            resizeMode="contain"
            onError={() => setFailed({ url: iconUrl, as: 'image' })}
            style={box}
          />
        )}
      </View>
    );
  }

  return (
    <View>
      {tile}
      {connected ? (
        <View
          className="absolute items-center justify-center rounded-full border-2 border-card bg-kortix-green"
          style={{ right: -4, bottom: -4, width: 18, height: 18 }}>
          <Icon as={CheckIcon} size={9} className="text-background" />
        </View>
      ) : null}
    </View>
  );
}

const TILE = 56;
const TILE_RADIUS = 16;
/** `[cx, r, opacity]` in a 24 × 6 box. */
const BRIDGE_DOTS = [
  [2, 1, 0.3],
  [7, 1.25, 0.7],
  [12, 1.75, 1],
  [17, 1.25, 0.7],
  [22, 1, 0.3],
] as const;

/** The sheet header: the Kortix tile, the dotted bridge, the app tile. */
export function ConnectorHandshake({ name, iconUrl }: Pick<ConnectorAppMarkProps, 'name' | 'iconUrl'>) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const dot = (isDark ? THEME.dark : THEME.light).mutedForeground;
  return (
    <View
      className="flex-row items-center"
      style={{ gap: 12 }}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants">
      <View
        className="items-center justify-center bg-foreground"
        style={{ width: TILE, height: TILE, borderRadius: TILE_RADIUS }}>
        {/* Inverted-fill tile: `foreground` swaps per theme, so the symbol
            swaps the other way. `KortixLogo` has no token colour. */}
        <KortixLogo size={24} color={isDark ? 'light' : 'dark'} />
      </View>
      {/* One SVG, as on web: five dots on one centre line at any scale. */}
      <Svg width={36} height={9} viewBox="0 0 24 6">
        {BRIDGE_DOTS.map(([cx, r, opacity]) => (
          <Circle key={cx} cx={cx} cy={3} r={r} opacity={opacity} fill={dot} />
        ))}
      </Svg>
      <ConnectorAppMark name={name} iconUrl={iconUrl} size={TILE} radius={TILE_RADIUS} />
    </View>
  );
}

/**
 * The body of a connect hand-off sheet (`ConnectorAuthSheet`,
 * `ConnectProviderSheet`): the handshake, what gets connected, one line on
 * what happens next, then the two pills.
 *
 * The primary pill names where it goes ("Continue to GitHub") and carries the
 * leaves-the-app arrow beside its label. Both pills are `lg` and full width,
 * so the pair reads as one stack; "Not now" is `secondary`, as on the upgrade
 * sheet.
 */
export function HandoffSheetBody({
  name,
  iconUrl,
  title,
  body,
  action,
  onContinue,
  onClose,
}: Pick<ConnectorAppMarkProps, 'name' | 'iconUrl'> & {
  title: string;
  body: string;
  /** The primary pill's label. */
  action: string;
  onContinue: () => void;
  onClose: () => void;
}) {
  return (
    <SheetBody className="items-center pt-4">
      <ConnectorHandshake name={name} iconUrl={iconUrl} />
      <Text variant="large" className="mt-6 text-center" accessibilityRole="header">
        {title}
      </Text>
      <Text variant="muted" className="mt-2 px-4 text-center leading-5">
        {body}
      </Text>
      <View className="mt-8 w-full" style={{ gap: 8 }}>
        <Button size="lg" className="rounded-full" onPress={onContinue}>
          <Text>{action}</Text>
          <Icon as={ArrowUpRightIcon} size={16} />
        </Button>
        <Button variant="secondary" size="lg" className="rounded-full" onPress={onClose}>
          <Text>Not now</Text>
        </Button>
      </View>
    </SheetBody>
  );
}
