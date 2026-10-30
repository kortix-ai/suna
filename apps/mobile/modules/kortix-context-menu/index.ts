/**
 * The iOS system context menu around React Native content
 * (`UIContextMenuInteraction` on a plain container view). React Native lays
 * the children out; a long press lifts the container and opens a native menu,
 * Liquid Glass on iOS 26.
 *
 * `null` on Android and on a binary built before this module (an OTA update
 * can reach one): the caller keeps its React Native menu there.
 */
import type * as React from 'react';
import { Platform, type ViewProps } from 'react-native';
import { requireNativeView, requireOptionalNativeModule } from 'expo';

export interface NativeContextMenuAction {
  /** Returned by `onPressAction`. */
  id: string;
  title: string;
  /** An SF Symbol name, e.g. `doc.on.doc`. */
  systemImage?: string;
}

export interface NativeContextMenuProps extends ViewProps {
  /** The menu's header line (empty: none). */
  menuTitle?: string;
  actions: NativeContextMenuAction[];
  /** The lifted preview's corner radius: the content's own corners. */
  previewCornerRadius?: number;
  /** `false` removes the long press, e.g. while the text is being selected. */
  enabled?: boolean;
  onPressAction?: (event: { nativeEvent: { id: string } }) => void;
}

export const NativeContextMenu: React.ComponentType<NativeContextMenuProps> | null =
  Platform.OS === 'ios' && requireOptionalNativeModule('KortixContextMenu') != null
    ? requireNativeView<NativeContextMenuProps>('KortixContextMenu')
    : null;
