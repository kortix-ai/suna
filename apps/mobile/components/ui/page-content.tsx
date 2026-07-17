/**
 * PageContent — the content area that sits under PageHeader.
 *
 * Flat continuation of the page surface: no card framing, just consistent
 * top breathing room so every page starts its content at the same rhythm
 * below the header.
 */

import * as React from 'react';
import { View, type ViewProps, type StyleProp, type ViewStyle } from 'react-native';

export interface PageContentProps extends ViewProps {
  /** Override the default `bg-background` surface (e.g. for dark terminal pages). */
  backgroundColor?: string;
  children?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}

export function PageContent({
  children,
  backgroundColor,
  style,
  ...viewProps
}: PageContentProps) {
  return (
    <View
      {...viewProps}
      className={backgroundColor ? undefined : 'bg-background'}
      style={[{ flex: 1 }, backgroundColor ? { backgroundColor } : null, style]}
    >
      {/* Top breathing room between the header and the first piece of
          content — 4 here + the header's 12 bottom padding = a uniform 16pt
          gap on every page. Pages that manage their own scroll/list padding
          should override via the `style` prop. */}
      <View style={{ paddingTop: 4, flex: 1 }}>{children}</View>
    </View>
  );
}
