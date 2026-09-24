/**
 * PlatformSegmentedTabs — a segmented tab switcher: native SwiftUI `Picker`
 * (`pickerStyle('segmented')`) on iOS, so it draws the system's own
 * segmented control and picks up Liquid Glass on iOS 26+ for free; the
 * design-system `Tabs` everywhere else (Android, web, and iOS binaries built
 * before `@expo/ui` shipped).
 *
 * Fills the width it is given (`flex: 1` on the native Host, `flex-1` on the
 * fallback `TabsList` — cancelling `TabsList`'s native default `mr-auto`,
 * which otherwise consumes the row's free space as margin instead of
 * growing the control). Pair it with a sibling control in a `flex-row`
 * parent (e.g. `PinnedBar`), not on its own.
 *
 * The fallback is a full pill (`rounded-full` track + `rounded-full` active
 * thumb, `bg-secondary`), not `TabsList`'s stock `rounded-lg`/`bg-muted` —
 * the closest a non-iOS control gets to the native segmented control's
 * rounded, capsule-shaped selection (Jay, 2026-09-22).
 *
 * OTA safety: same guard as `PlatformButton` — the SwiftUI path is used only
 * when the `ExpoUI` native module is present in the running binary.
 */

import * as React from 'react';
import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo';
import { useColorScheme } from 'nativewind';

import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Text } from '@/components/ui/text';

type SwiftUIModule = typeof import('@expo/ui/swift-ui');
type SwiftUIModifiers = typeof import('@expo/ui/swift-ui/modifiers');

const nativeUIAvailable = Platform.OS === 'ios' && requireOptionalNativeModule('ExpoUI') != null;
const swiftUI: SwiftUIModule | null = nativeUIAvailable
  ? (require('@expo/ui/swift-ui') as SwiftUIModule)
  : null;
const swiftUIModifiers: SwiftUIModifiers | null = nativeUIAvailable
  ? (require('@expo/ui/swift-ui/modifiers') as SwiftUIModifiers)
  : null;

/** Matches `Button size="icon"` (h-10), the height of the `+` it sits beside. */
const CONTROL_HEIGHT = 40;

export interface PlatformSegmentedTabsSegment<T extends string> {
  key: T;
  label: string;
  accessibilityLabel?: string;
}

export interface PlatformSegmentedTabsProps<T extends string> {
  segments: PlatformSegmentedTabsSegment<T>[];
  value: T;
  onValueChange: (value: T) => void;
}

export function PlatformSegmentedTabs<T extends string>({
  segments,
  value,
  onValueChange,
}: PlatformSegmentedTabsProps<T>) {
  const { colorScheme } = useColorScheme();

  if (swiftUI && swiftUIModifiers) {
    const { Host, Picker, Text: NativeText } = swiftUI;
    const { pickerStyle, tag } = swiftUIModifiers;
    return (
      <Host
        style={{ flex: 1, height: CONTROL_HEIGHT }}
        colorScheme={colorScheme === 'dark' ? 'dark' : 'light'}>
        <Picker
          selection={value}
          onSelectionChange={(selection) => onValueChange(selection as T)}
          modifiers={[pickerStyle('segmented')]}>
          {segments.map((segment) => (
            <NativeText key={segment.key} modifiers={[tag(segment.key)]}>
              {segment.label}
            </NativeText>
          ))}
        </Picker>
      </Host>
    );
  }

  return (
    <Tabs
      value={value}
      onValueChange={(next) => {
        if (next) onValueChange(next as T);
      }}
      className="flex-1">
      <TabsList className="mr-0 flex-1 h-10 rounded-full bg-secondary">
        {segments.map((segment) => (
          <TabsTrigger
            key={segment.key}
            value={segment.key}
            className="flex-1 rounded-full h-[2.2rem]"
            accessibilityLabel={segment.accessibilityLabel ?? segment.label}>
            <Text numberOfLines={1}>{segment.label}</Text>
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}
