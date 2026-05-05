import * as Haptics from 'expo-haptics';
import { useSoundStore } from '@/stores/sound-store';

// Single source of truth for whether the device should buzz, read live from
// the persisted sound store (default ON, toggled in Settings → Sounds).
//
// We expose two things:
//   1. `haptics.{tap,medium,selection,success,warning}` — convenience wrappers
//      with intent-based names (used by chat, bottom bar, etc).
//   2. `installHapticsGate()` — called once at app boot from the root layout.
//      It monkey-patches the underlying `expo-haptics` module so that the
//      ~140 other call sites that import `* as Haptics` from `expo-haptics`
//      directly are also silenced when the user turns haptics off, without
//      having to migrate each one.
//
// Why a getter call per fire (instead of caching the flag): the user can
// toggle the setting at any time and we want the change to take effect
// instantly — and Zustand's `getState()` is a cheap synchronous read.

const isEnabled = (): boolean => {
  // Defensive try/catch in case this runs before the store is hydrated from
  // AsyncStorage. Default to true so first-launch haptics aren't suppressed.
  try {
    return useSoundStore.getState().preferences.hapticsEnabled !== false;
  } catch {
    return true;
  }
};

export const haptics = {
  tap: () => {
    if (!isEnabled()) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
  },
  medium: () => {
    if (!isEnabled()) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
  },
  selection: () => {
    if (!isEnabled()) return;
    Haptics.selectionAsync().catch(() => {});
  },
  success: () => {
    if (!isEnabled()) return;
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
  },
  warning: () => {
    if (!isEnabled()) return;
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
  },
};

// ---------------------------------------------------------------------------
// Global gate — patches expo-haptics so direct callers respect the setting.
//
// Every file in this app uses `import * as Haptics from 'expo-haptics'`, which
// resolves to a single module namespace object. Replacing the three async
// functions on that object once at startup means every subsequent call from
// anywhere — chat, settings rows, drawers, tool views — reads the wrapped
// version and gets gated. Original functions are saved and called through so
// behaviour is identical when the toggle is on.
// ---------------------------------------------------------------------------

let installed = false;

export function installHapticsGate(): void {
  if (installed) return;
  installed = true;

  const originalImpact = Haptics.impactAsync;
  const originalSelection = Haptics.selectionAsync;
  const originalNotification = Haptics.notificationAsync;

  // Cast to `any` so we can write back onto the imported namespace. Metro's
  // interop layer makes these properties writable; this is the same trick
  // libraries like `react-native-reanimated` use to install global handlers.
  const HapticsAny = Haptics as any;

  HapticsAny.impactAsync = (style?: Haptics.ImpactFeedbackStyle) => {
    if (!isEnabled()) return Promise.resolve();
    return originalImpact(style);
  };

  HapticsAny.selectionAsync = () => {
    if (!isEnabled()) return Promise.resolve();
    return originalSelection();
  };

  HapticsAny.notificationAsync = (type?: Haptics.NotificationFeedbackType) => {
    if (!isEnabled()) return Promise.resolve();
    return originalNotification(type);
  };
}
