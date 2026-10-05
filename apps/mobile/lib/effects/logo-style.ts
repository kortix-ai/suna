/**
 * The style of the project home's Kortix symbol (`MetalKortixLogo`), as a
 * choice the user can make from the hidden sheet (`LogoPaletteSheet`). Pure:
 * no React Native, so it runs under `bun test`.
 *
 * Two styles, one shader each (`lib/effects/*-sksl.ts`), both driven by the
 * same tilt (`useTiltMotion`): a move sweeps the shader's time, the direction
 * of the move turns its angle.
 *  - `dither`: Paper's Dithering, the default (Jay, 2026-09-22). A lit sphere
 *    through the symbol's silhouette, in Bayer-dithered cells.
 *  - `heatmap`: Paper's Heatmap. Streaks of heat over the symbol's edges.
 *
 * The liquid-metal style (Paper's LiquidMetal, chrome stripes with colour
 * dispersion) shipped briefly on 2026-09-22 and was removed the same day
 * (Jay: keep only heatmap and dither). Its shader
 * (`lib/effects/liquid-metal-sksl.ts`) and tint colour are gone; the shared
 * mask texture (`assets/brand/kortix-liquid-metal.png`,
 * `lib/effects/liquid-metal-bake.ts`) stays, because the dither style also
 * reads its alpha plane — only the edge plane it once fed is now unused.
 */
import type { LogoTone, Rgba } from '@/lib/effects/logo-palette';

export const LOGO_STYLES = [
  { id: 'dither', label: 'Dither' },
  { id: 'heatmap', label: 'Heatmap' },
] as const satisfies ReadonlyArray<{ id: string; label: string }>;

export type LogoStyleId = (typeof LOGO_STYLES)[number]['id'];
export const DEFAULT_LOGO_STYLE_ID: LogoStyleId = 'dither';

export function isLogoStyleId(value: unknown): value is LogoStyleId {
  return LOGO_STYLES.some((style) => style.id === value);
}

/**
 * The fixed brand-metal colour of the dither's cells, per page tone. Not a
 * themed UI surface: Paper's white on a dark page, near-black on a light one.
 * The heatmap's pair lives in `MetalKortixLogo`.
 */
// hex-allowlist: dark = white #FFFFFF; light = near-black #242424 (the heatmap's fixed value)
export const LOGO_STYLE_COLORS: Record<LogoTone, { dither: { front: Rgba } }> = {
  dark: { dither: { front: [1, 1, 1, 1] } },
  light: { dither: { front: [0.141, 0.141, 0.141, 1] } },
};
