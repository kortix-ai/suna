/**
 * Switch — the app's one toggle (Jay, 2026-10-20). iOS draws the native
 * `UISwitch` (React Native `Switch`, system colours; Liquid Glass on iOS 26).
 * Android keeps the design-system switch (`@/components/ui/switch`, RNR
 * registry output, never edited). Same props on both: `checked`,
 * `onCheckedChange`, `disabled`, plus accessibility props.
 *
 * Import this, never `@/components/ui/switch`, in a screen.
 */
import * as React from 'react';
import { Platform, Switch as NativeSwitch } from 'react-native';

import { Switch as RegistrySwitch } from '@/components/ui/switch';

type SwitchProps = React.ComponentProps<typeof RegistrySwitch>;

export function Switch(props: SwitchProps) {
  if (Platform.OS !== 'ios') return <RegistrySwitch {...props} />;
  const { checked, onCheckedChange, disabled, accessibilityLabel, accessibilityHint, testID } = props;
  return (
    <NativeSwitch
      value={checked}
      onValueChange={onCheckedChange}
      disabled={disabled ?? undefined}
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      testID={testID}
    />
  );
}
