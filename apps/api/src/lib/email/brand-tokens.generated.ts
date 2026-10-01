// GENERATED from visual-system.json by .agents/skills/kortix-brand/scripts/generate-tokens.ts. Do not edit.
// Light-theme hex for transactional email. Email clients cannot read CSS variables.

export const EMAIL_COLORS = {
  canvas: '#ffffff', // --background
  surface1: '#f4f4f4', // --card
  ink: '#1f1f1f', // --foreground
  inkMuted: '#666666', // --muted-foreground
  hairline: '#e2e2e2', // --border
  kortixBase: '#0099ff', // --kortix-base
  success: '#199338', // --kortix-green
  error: '#f14b4c', // --kortix-red
  warning: '#d18b19', // --kortix-orange
  pending: '#cca300', // --kortix-yellow
  info: '#2b91f7', // --kortix-blue
} as const;

// System stacks only: email clients cannot load Roobert (decisions D8a, Q27).
export const EMAIL_FONT_SANS = "ui-sans-serif, -apple-system, 'Segoe UI', 'Helvetica Neue', 'Noto Sans', sans-serif";
export const EMAIL_FONT_MONO = "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace";

// Whole pixels, from visual-system.json "email".
export const EMAIL_LAYOUT = {
  "containerWidth": 520,
  "sidePadding": 32,
  "cardRadius": 14,
  "buttonRadius": 8,
  "buttonPadding": "12px 28px",
  "logoHeight": 22,
  "logoUrl": "https://kortix.com/brandkit/Logo/Logomark/PNG/Logomark%20Black.png",
  "fontSize": {
    "title": 22,
    "body": 14,
    "kicker": 13,
    "small": 12
  },
  "lineHeight": {
    "title": 1.25,
    "body": 1.6
  },
  "gap": {
    "kicker_before": 24,
    "kicker_after": 8,
    "title_after": 12,
    "block_after": 24
  }
} as const;
