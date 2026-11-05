/**
 * When a surface may draw iOS 26 Liquid Glass (KRTX-2928).
 *
 * Glass is drawn by UIKit's `UIGlassEffect`, through `expo-glass-effect`
 * (`components/kortix/liquid-glass.tsx`). Three conditions:
 * - iOS. Android keeps its current surface.
 * - iOS 26 or later. Before 26 there is no `UIGlassEffect`, so an older iOS
 *   must keep the opaque surface instead of an empty capsule.
 * - The running binary has the `ExpoGlassEffect` native module.
 *   `runtimeVersion` is a fixed string, so an OTA update can reach a binary
 *   built without it.
 *
 * Pure (no React Native import), so bun test loads it.
 */
export function supportsLiquidGlass(os: string, version: string | number, hasExpoUI: boolean): boolean {
  if (os !== 'ios' || !hasExpoUI) return false;
  const major = Number.parseInt(String(version), 10);
  return Number.isFinite(major) && major >= 26;
}
