#!/usr/bin/env bun
/**
 * Color Palette Generator for Website Building
 *
 * Generates unique, harmonious color palettes based on a theme/subject.
 * Uses color theory (analogous, complementary, triadic, split-complementary)
 * to produce palettes that work for both light and dark modes.
 *
 * Usage:
 *   bun run generate-palette.ts "coffee shop warm cozy"
 *   bun run generate-palette.ts "tech startup futuristic"
 *   bun run generate-palette.ts "botanical garden nature"
 *
 * Output: CSS variables ready to paste into your stylesheet.
 */

// ── Color math ───────────────────────────────────────────────────────────────

function hslToHex(h: number, s: number, l: number): string {
  h = ((h % 360) + 360) % 360
  s = Math.max(0, Math.min(100, s)) / 100
  l = Math.max(0, Math.min(100, l)) / 100
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) => {
    const k = (n + h / 30) % 12
    const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1)
    return Math.round(255 * color).toString(16).padStart(2, '0')
  }
  return `#${f(0)}${f(8)}${f(4)}`
}

function hexToHsl(hex: string): [number, number, number] {
  const r = parseInt(hex.slice(1, 3), 16) / 255
  const g = parseInt(hex.slice(3, 5), 16) / 255
  const b = parseInt(hex.slice(5, 7), 16) / 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  let h = 0, s = 0, l = (max + min) / 2
  if (max !== min) {
    const d = max - min
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60
    else if (max === g) h = ((b - r) / d + 2) * 60
    else h = ((r - g) / d + 4) * 60
  }
  return [Math.round(h), Math.round(s * 100), Math.round(l * 100)]
}

function adjustLightness(hex: string, amount: number): string {
  const [h, s, l] = hexToHsl(hex)
  return hslToHex(h, s, Math.max(0, Math.min(100, l + amount)))
}

function desaturate(hex: string, amount: number): string {
  const [h, s, l] = hexToHsl(hex)
  return hslToHex(h, Math.max(0, s - amount), l)
}

// ── Theme-to-hue mapping ─────────────────────────────────────────────────────

const THEME_HUES: Record<string, number[]> = {
  // Warm
  coffee: [25, 30, 35], espresso: [20, 25], warm: [30, 35, 40], cozy: [25, 30, 35],
  autumn: [20, 30, 40], rustic: [25, 35], bakery: [30, 35, 40], chocolate: [15, 20, 25],
  // Earth
  nature: [90, 120, 140], botanical: [100, 130, 150], garden: [110, 130], forest: [140, 150, 160],
  plant: [100, 120, 140], organic: [80, 100, 120], earth: [30, 50, 80], desert: [35, 40, 45],
  // Cool
  ocean: [200, 210, 220], sea: [190, 200, 210], water: [195, 205, 215], ice: [195, 200, 210],
  sky: [200, 210, 220], arctic: [190, 200], marine: [200, 215],
  // Tech
  tech: [220, 240, 260], cyber: [270, 280, 290], digital: [230, 250], ai: [250, 260, 270],
  startup: [220, 240, 260], futuristic: [260, 270, 280], neon: [150, 270, 320],
  // Creative
  art: [330, 340, 350], creative: [300, 320, 340], music: [270, 280, 330],
  vinyl: [15, 20, 30], retro: [20, 30, 350], jazz: [30, 35, 280],
  // Luxury
  luxury: [40, 45, 50], gold: [42, 45, 48], premium: [40, 260], elegant: [270, 280, 45],
  royal: [260, 270], wine: [340, 345, 350], jewel: [160, 270, 340],
  // Health
  health: [140, 150, 160], medical: [190, 200, 210], wellness: [150, 160, 170],
  spa: [170, 175, 180], yoga: [30, 160, 270], fitness: [0, 10, 200],
  // Food
  restaurant: [0, 10, 350], food: [20, 30, 350], pizza: [10, 20, 30],
  sushi: [0, 10, 200], vegan: [100, 120, 140], tea: [80, 100, 40],
  // Academic
  academic: [220, 230, 240], science: [200, 220, 260], physics: [230, 250, 270],
  chemistry: [150, 160, 200], history: [30, 40, 45], literary: [270, 280, 340],
  // Misc
  dark: [0, 220, 260], light: [40, 50, 200], minimal: [0, 0, 0],
  playful: [340, 30, 180], kids: [340, 50, 180, 270], fun: [320, 40, 170],
}

function getHueFromTheme(theme: string): number {
  const words = theme.toLowerCase().split(/\s+/)
  const candidates: number[] = []
  for (const word of words) {
    if (THEME_HUES[word]) candidates.push(...THEME_HUES[word])
  }
  if (candidates.length === 0) {
    // Hash the theme string to get a deterministic but varied hue
    let hash = 0
    for (let i = 0; i < theme.length; i++) hash = ((hash << 5) - hash + theme.charCodeAt(i)) | 0
    return Math.abs(hash) % 360
  }
  // Pick a random one from candidates + add some variation
  const base = candidates[Math.floor(Math.random() * candidates.length)]
  return (base + Math.floor(Math.random() * 20) - 10 + 360) % 360
}

// ── Palette generation ───────────────────────────────────────────────────────

type Harmony = 'analogous' | 'complementary' | 'triadic' | 'split-complementary' | 'monochromatic'

function generateHarmony(baseHue: number, type: Harmony): number[] {
  switch (type) {
    case 'analogous': return [baseHue, (baseHue + 30) % 360, (baseHue - 30 + 360) % 360]
    case 'complementary': return [baseHue, (baseHue + 180) % 360]
    case 'triadic': return [baseHue, (baseHue + 120) % 360, (baseHue + 240) % 360]
    case 'split-complementary': return [baseHue, (baseHue + 150) % 360, (baseHue + 210) % 360]
    case 'monochromatic': return [baseHue]
  }
}

interface Palette {
  name: string
  harmony: Harmony
  primary: string
  primaryHover: string
  accent: string
  bg: { light: string; dark: string }
  surface: { light: string; dark: string }
  text: { light: string; dark: string }
  textMuted: { light: string; dark: string }
  border: { light: string; dark: string }
}

function generatePalette(baseHue: number, harmony: Harmony): Palette {
  const hues = generateHarmony(baseHue, harmony)
  const primaryHue = hues[0]
  const accentHue = hues.length > 1 ? hues[1] : (primaryHue + 40) % 360

  // Saturation and lightness vary by harmony
  const sat = 50 + Math.floor(Math.random() * 30) // 50-80%

  const primary = hslToHex(primaryHue, sat, 45)
  const primaryHover = hslToHex(primaryHue, sat, 35)
  const accent = hslToHex(accentHue, sat - 10, 50)

  // Generate neutral backgrounds tinted toward the primary hue
  const bgTint = primaryHue
  const bgSat = 5 + Math.floor(Math.random() * 8) // very subtle tint

  return {
    name: `${['analogous','complementary','triadic','split-complementary','monochromatic'].indexOf(harmony) + 1}-${harmony}`,
    harmony,
    primary,
    primaryHover,
    accent,
    bg: {
      light: hslToHex(bgTint, bgSat, 96),
      dark: hslToHex(bgTint, bgSat + 3, 7),
    },
    surface: {
      light: hslToHex(bgTint, bgSat, 98),
      dark: hslToHex(bgTint, bgSat + 3, 10),
    },
    text: {
      light: hslToHex(bgTint, 10, 12),
      dark: hslToHex(bgTint, 8, 88),
    },
    textMuted: {
      light: hslToHex(bgTint, 6, 45),
      dark: hslToHex(bgTint, 6, 55),
    },
    border: {
      light: hslToHex(bgTint, bgSat, 85),
      dark: hslToHex(bgTint, bgSat + 3, 18),
    },
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

const theme = process.argv.slice(2).join(' ') || 'general'
const baseHue = getHueFromTheme(theme)

const harmonies: Harmony[] = ['analogous', 'complementary', 'triadic', 'split-complementary', 'monochromatic']
const palettes: Palette[] = harmonies.map(h => generatePalette(baseHue, h))

console.log(`## Generated Palettes for "${theme}"\n`)
console.log(`Base hue: ${baseHue}°\n`)

for (const p of palettes) {
  console.log(`### ${p.harmony.charAt(0).toUpperCase() + p.harmony.slice(1)} (${p.name})`)
  console.log(`Primary: ${p.primary} | Accent: ${p.accent}\n`)
  console.log('```css')
  console.log(`:root, [data-theme="light"] {
  --color-bg: ${p.bg.light};
  --color-surface: ${p.surface.light};
  --color-text: ${p.text.light};
  --color-text-muted: ${p.textMuted.light};
  --color-border: ${p.border.light};
  --color-primary: ${p.primary};
  --color-primary-hover: ${p.primaryHover};
  --color-accent: ${p.accent};
}

[data-theme="dark"] {
  --color-bg: ${p.bg.dark};
  --color-surface: ${p.surface.dark};
  --color-text: ${p.text.dark};
  --color-text-muted: ${p.textMuted.dark};
  --color-border: ${p.border.dark};
  --color-primary: ${adjustLightness(p.primary, 15)};
  --color-primary-hover: ${adjustLightness(p.primaryHover, 15)};
  --color-accent: ${adjustLightness(p.accent, 15)};
}`)
  console.log('```\n')
}

console.log('---')
console.log('Pick the palette that best fits the subject. Copy the CSS variables into your stylesheet.')
console.log('Then customize: adjust saturation, tweak specific colors, add gradients as needed.')
