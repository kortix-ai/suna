/**
 * PageContent — the rounded-top content card that sits under PageHeader.
 *
 * Pulls up by -24 to tuck under the header's extra bottom padding, rounds
 * the top corners, and adds a hairline border around the exposed edges —
 * matching the session page's layout.
 *
 * Pair with <PageHeader> (which defaults to paddingBottom=36 so the overlap
 * looks right). If a page doesn't need the card treatment, set PageHeader's
 * `paddingBottom` to 12 and render content directly without this wrapper.
 */

import * as React from 'react';
import { StyleSheet, View, type ViewProps, type StyleProp, type ViewStyle } from 'react-native';
import { useColorScheme } from 'nativewind';

export interface PageContentProps extends ViewProps {
  /** Override the default `bg-background` surface (e.g. for dark terminal pages). */
  backgroundColor?: string;
  /** Inner style — passed through to the inner content View. The outer
   *  wrapper owns layout/radius/border and must not be styled externally. */
  children?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}

export function PageContent({
  children,
  backgroundColor,
  style,
  ...viewProps
}: PageContentProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const borderColor = isDark ? '#222222' : '#e6e6e5';

  return (
    <View
      {...viewProps}
      style={[
        {
          flex: 1,
          marginTop: -24,
          borderTopLeftRadius: 28,
          borderTopRightRadius: 28,
          overflow: 'hidden',
          borderTopWidth: 2,
          borderLeftWidth: 2,
          borderRightWidth: 2,
          borderColor,
          backgroundColor: backgroundColor ?? (isDark ? '#0D0D0D' : '#FFFFFF'),
        },
        style,
      ]}
    >
      {/* Top breathing room between the card's rounded edge and the first
          piece of content. Matches the session page's `contentContainerStyle={{ paddingTop: 16 }}` inset,
          so every page has identical spacing below the header. Pages that manage
          their own scroll/list padding should override via the `style` prop. */}
      <View style={{ paddingTop: 16, flex: 1 }}>{children}</View>
    </View>
  );
}
