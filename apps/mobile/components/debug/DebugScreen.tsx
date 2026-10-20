/**
 * DebugScreen — dev builds only. One place to check what the running build
 * detects and to try the surfaces that depend on it.
 *
 * - Detect: platform, OS and app versions, OTA update, the native modules the
 *   glass and blur surfaces need (`ExpoUI`, `ExpoBlur`), Liquid Glass on/off,
 *   Reduce Motion / Reduce Transparency, theme, safe-area insets. "Copy"
 *   puts the whole list on the clipboard as text for a bug report.
 * - Glass: the switcher capsule (tap or drag), the chat input and every toast
 *   type, so a Liquid Glass change can be checked without a live session.
 * - Links to the other debug screens, and to the MFA code screen
 *   (`/mfa-preview`: fake verify, `000000` passes).
 *
 * Open it from the project home's "Debug" button, or `kortix://debug`.
 */

import * as React from 'react';
import { AccessibilityInfo, Platform, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { requireOptionalNativeModule } from 'expo';
import * as Clipboard from 'expo-clipboard';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Updates from 'expo-updates';
import { useReducedMotion } from 'react-native-reanimated';
import { useColorScheme } from 'nativewind';

import { Composer } from '@/components/kortix/composer';
import { LIQUID_GLASS_AVAILABLE } from '@/components/kortix/liquid-glass-capsule';
import { useToast } from '@/components/kortix/toast-provider';
import { FloatingTabCapsule } from '@/components/navigation/FloatingTabBar';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Separator } from '@/components/ui/separator';
import { Text } from '@/components/ui/text';
import { CaretLeftIcon, CubeIcon, RobotIcon } from '@/lib/icons';

type Row = [label: string, value: string];

const yesNo = (value: boolean) => (value ? 'Yes' : 'No');

function useDetectRows(): Row[] {
  const insets = useSafeAreaInsets();
  const reducedMotion = useReducedMotion();
  const { colorScheme } = useColorScheme();
  const [reduceTransparency, setReduceTransparency] = React.useState<boolean | null>(null);

  React.useEffect(() => {
    if (Platform.OS !== 'ios') return;
    let alive = true;
    AccessibilityInfo.isReduceTransparencyEnabled().then((value) => alive && setReduceTransparency(value));
    const sub = AccessibilityInfo.addEventListener('reduceTransparencyChanged', setReduceTransparency);
    return () => {
      alive = false;
      sub.remove();
    };
  }, []);

  return [
    ['Platform', Platform.OS],
    ['OS version', String(Platform.Version)],
    ['Device', Device.modelName ?? 'Unknown'],
    ['App version', Constants.expoConfig?.version ?? 'Unknown'],
    ['Runtime version', Updates.runtimeVersion ?? 'None'],
    ['Update', Updates.isEmbeddedLaunch ? 'Embedded bundle' : (Updates.updateId ?? 'Unknown')],
    ['Channel', Updates.channel ?? 'None'],
    ['Dev build', yesNo(__DEV__)],
    ['ExpoUI native module', yesNo(requireOptionalNativeModule('ExpoUI') != null)],
    ['ExpoBlur native module', yesNo(requireOptionalNativeModule('ExpoBlur') != null)],
    ['Liquid Glass', yesNo(LIQUID_GLASS_AVAILABLE)],
    ['Reduce Motion', yesNo(reducedMotion)],
    ['Reduce Transparency', Platform.OS !== 'ios' ? 'iOS only' : reduceTransparency == null ? '…' : yesNo(reduceTransparency)],
    ['Theme', colorScheme ?? 'Unknown'],
    ['Safe area (top / bottom)', `${Math.round(insets.top)} / ${Math.round(insets.bottom)} pt`],
  ];
}

function SectionTitle({ children }: { children: string }) {
  return (
    <Text variant="large" className="pb-3 pt-6">
      {children}
    </Text>
  );
}

export function DebugScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const toast = useToast();
  const rows = useDetectRows();
  const [tab, setTab] = React.useState(0);
  const [draft, setDraft] = React.useState('');

  const copyReport = async () => {
    await Clipboard.setStringAsync(rows.map(([label, value]) => `${label}: ${value}`).join('\n'));
    toast.success('Copied');
  };

  return (
    <View className="flex-1 bg-background" style={{ paddingTop: insets.top }}>
      <View className="flex-row items-center gap-2 px-2 pb-2">
        <Button variant="ghost" size="icon" className="rounded-full" accessibilityLabel="Back" onPress={() => router.back()}>
          <Icon as={CaretLeftIcon} size={20} />
        </Button>
        <Text variant="large" className="flex-1">
          Debug
        </Text>
        <Button variant="secondary" size="sm" className="mr-2 rounded-full" onPress={copyReport}>
          <Text>Copy</Text>
        </Button>
      </View>

      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: insets.bottom + 32 }}>
        <SectionTitle>Detect</SectionTitle>
        {rows.map(([label, value]) => (
          <View key={label} className="flex-row items-baseline justify-between gap-4 py-2">
            <Text variant="muted">{label}</Text>
            <Text className="shrink text-right" selectable>
              {value}
            </Text>
          </View>
        ))}

        <Separator className="mt-4" />
        <SectionTitle>Switcher</SectionTitle>
        <View className="items-center">
          <FloatingTabCapsule
            glass
            activeIndex={tab}
            onSelect={setTab}
            items={[
              { key: 'agent', label: 'Agent', icon: <Icon as={RobotIcon} size={20} className="text-foreground" /> },
              { key: 'model', label: 'Model', icon: <Icon as={CubeIcon} size={20} className="text-foreground" /> },
            ]}
          />
        </View>

        <SectionTitle>Chat input</SectionTitle>
        <Composer
          value={draft}
          onChangeText={setDraft}
          onSubmit={() => {
            toast.info(draft.trim() || 'Sent');
            setDraft('');
          }}
          onAttach={() => toast.info('Attach')}
          placeholder="Type to test the input"
        />

        <SectionTitle>Toasts</SectionTitle>
        <View className="flex-row flex-wrap gap-2">
          <Button variant="secondary" size="sm" className="rounded-full" onPress={() => toast.success('Saved')}>
            <Text>Success</Text>
          </Button>
          <Button
            variant="secondary"
            size="sm"
            className="rounded-full"
            onPress={() => toast.error('Unable to save. Try again.', { description: 'The network request failed.' })}>
            <Text>Error</Text>
          </Button>
          <Button variant="secondary" size="sm" className="rounded-full" onPress={() => toast.info('Session shared')}>
            <Text>Info</Text>
          </Button>
          <Button variant="secondary" size="sm" className="rounded-full" onPress={() => toast.warning('Credits are low')}>
            <Text>Warning</Text>
          </Button>
          <Button
            variant="secondary"
            size="sm"
            className="rounded-full"
            onPress={() => {
              toast
                .promise(new Promise((resolve) => setTimeout(resolve, 1500)), {
                  loading: 'Uploading…',
                  success: 'Uploaded',
                })
                .catch(() => {});
            }}>
            <Text>Loading → Success</Text>
          </Button>
          <Button
            variant="secondary"
            size="sm"
            className="rounded-full"
            onPress={() =>
              toast.success('Session deleted', {
                action: { kind: 'undo', label: 'Undo', onPress: () => toast.info('Restored') },
              })
            }>
            <Text>With Undo</Text>
          </Button>
        </View>

        <Separator className="mt-6" />
        <SectionTitle>Other screens</SectionTitle>
        <View className="flex-row flex-wrap gap-2">
          <Button variant="secondary" size="sm" className="rounded-full" onPress={() => router.push('/genui-debug')}>
            <Text>Generative UI</Text>
          </Button>
          <Button variant="secondary" size="sm" className="rounded-full" onPress={() => router.push('/session-fixture')}>
            <Text>Session fixture</Text>
          </Button>
          <Button variant="secondary" size="sm" className="rounded-full" onPress={() => router.push('/mfa-preview')}>
            <Text>MFA code screen</Text>
          </Button>
        </View>
      </ScrollView>
    </View>
  );
}
