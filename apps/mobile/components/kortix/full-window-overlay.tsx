/**
 * FullWindowOverlay — iOS wraps portal content in react-native-screens'
 * FullWindowOverlay so it draws above every modal; Android needs no wrapper.
 * Shared by the portal-based primitives (dialog, alert-dialog, popover,
 * context-menu, select).
 */
import * as React from 'react';
import { Platform } from 'react-native';
import { FullWindowOverlay as RNFullWindowOverlay } from 'react-native-screens';

export const FullWindowOverlay = Platform.OS === 'ios' ? RNFullWindowOverlay : React.Fragment;
