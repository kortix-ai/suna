import * as Haptics from 'expo-haptics';

// Thin wrappers around expo-haptics so callers don't have to swallow the
// promise rejection at every call site (haptics fail silently on devices
// without a Taptic Engine, e.g. older Androids and the simulator).
//
// Naming follows intent, not the underlying ImpactFeedbackStyle:
//   tap        — discrete tap on a button (light)
//   medium     — heavier tap, e.g. stopping a run
//   selection  — picker-wheel tick, used for transitions and section changes
//   success    — soft completion notification (e.g. assistant finished)
//   warning    — soft warning notification (e.g. stream error)

export const haptics = {
  tap: () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {}),
  medium: () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {}),
  selection: () => Haptics.selectionAsync().catch(() => {}),
  success: () =>
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {}),
  warning: () =>
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {}),
};
