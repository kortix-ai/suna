/**
 * Self-hosted instance — the sheet behind the auth screen's Self-hosted button.
 *
 * The user enters the address they open Kortix at in a browser (the same URL
 * the desktop app's instance chooser takes). The address is checked before
 * anything is saved (lib/deployment `checkDeployment`): it must serve the
 * Kortix runtime config and its API must answer. Connecting reloads the app on
 * the new deployment (`switchDeployment`).
 */

import * as React from 'react';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Sheet, SheetBody, SheetHeader, type SheetRef } from '@/components/kortix/sheet';
import { SheetTextInput } from '@/components/kortix/SheetInput';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { checkDeployment, type Deployment } from '@/lib/deployment/deployment';
import { activeDeployment } from '@/lib/deployment/store';
import { switchDeployment } from '@/lib/deployment/switch';

export const DeploymentSheet = React.forwardRef<SheetRef>(function DeploymentSheet(_props, ref) {
  const insets = useSafeAreaInsets();
  const sheetRef = React.useRef<SheetRef>(null);
  const initial = activeDeployment ? new URL(activeDeployment.origin).host : '';
  const [address, setAddress] = React.useState(initial);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState<'connect' | 'cloud' | null>(null);

  React.useImperativeHandle(
    ref,
    () => ({
      open: () => {
        setAddress(initial);
        setError(null);
        sheetRef.current?.open();
      },
      close: () => sheetRef.current?.close(),
    }),
    [initial]
  );

  const apply = async (deployment: Deployment | null) => {
    if (!(await switchDeployment(deployment))) {
      setPending(null);
      setError('Saved. Close and reopen Kortix to connect.');
    }
  };

  const connect = async () => {
    if (pending || !address.trim()) return;
    setPending('connect');
    setError(null);
    const result = await checkDeployment(address, (url, init) => fetch(url, init));
    if (!result.ok) {
      setPending(null);
      setError(result.error);
      return;
    }
    // Also for the current deployment: it refreshes the saved auth settings.
    await apply(result.deployment);
  };

  const resetToCloud = async () => {
    if (pending) return;
    setPending('cloud');
    setError(null);
    await apply(null);
  };

  return (
    <Sheet ref={sheetRef} fullScreen enablePanDownToClose>
      <SheetHeader title="Self-hosted instance" />
      <SheetBody className="gap-3">
        <SheetTextInput
          value={address}
          onChangeText={(value) => {
            setAddress(value);
            setError(null);
          }}
          placeholder="kortix.example.com"
          accessibilityLabel="Instance URL"
          keyboardType="url"
          textContentType="URL"
          autoCapitalize="none"
          autoCorrect={false}
          editable={!pending}
          returnKeyType="go"
          onSubmitEditing={() => void connect()}
        />
        {error ? (
          <Text variant="muted" className="text-destructive">
            {error}
          </Text>
        ) : null}
        <Button
          size="lg"
          className="rounded-full"
          disabled={!!pending || !address.trim()}
          onPress={() => void connect()}>
          <Text>{pending === 'connect' ? 'Connecting…' : 'Connect'}</Text>
        </Button>
        {activeDeployment ? (
          <Button
            size="lg"
            variant="secondary"
            className="rounded-full"
            disabled={!!pending}
            onPress={() => void resetToCloud()}>
            <Text>{pending === 'cloud' ? 'Switching…' : 'Use Kortix Cloud'}</Text>
          </Button>
        ) : null}
      </SheetBody>
      <View style={{ height: insets.bottom }} />
    </Sheet>
  );
});
