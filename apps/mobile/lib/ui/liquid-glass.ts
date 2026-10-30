/**
 * When a surface may draw iOS 26 Liquid Glass (KRTX-2928).
 *
 * Glass is drawn by SwiftUI's `glassEffect`, through `@expo/ui` (already in
 * the binary for `PlatformButton`; no extra native module). Three conditions:
 * - iOS. Android keeps its current surface.
 * - iOS 26 or later. Before 26, `glassEffect` draws nothing at all (expo-ui's
 *   `GlassEffectModifier` returns the bare content), so an older iOS must keep
 *   the opaque surface instead of an empty capsule.
 * - The running binary has the `ExpoUI` native module. `runtimeVersion` is a
 *   fixed string, so an OTA update can reach a binary built without it.
 *
 * Pure (no React Native import), so bun test loads it.
 */
export function supportsLiquidGlass(os: string, version: string | number, hasExpoUI: boolean): boolean {
  if (os !== 'ios' || !hasExpoUI) return false;
  const major = Number.parseInt(String(version), 10);
  return Number.isFinite(major) && major >= 26;
}
