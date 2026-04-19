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
  const borderColor = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';

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
          borderTopWidth: StyleSheet.hairlineWidth,
          borderLeftWidth: StyleSheet.hairlineWidth,
          borderRightWidth: StyleSheet.hairlineWidth,
          borderColor,
          backgroundColor: backgroundColor ?? (isDark ? '#0D0D0D' : '#FFFFFF'),
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}
