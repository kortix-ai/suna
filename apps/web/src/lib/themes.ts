export interface KortixTheme {
  id: string;
  name: string;
  /** Hex color for the accent dot in the theme picker */
  accentColor: string;
  description: string;
}

export const DEFAULT_THEME_ID = 'graphite';

/**
 * Theme philosophy: Black & White + 1 accent color.
 * All backgrounds, surfaces, borders, and text are pure neutral (zero chroma).
 * Only primary, ring, sidebar-primary, and charts carry the accent hue.
 */
export const THEMES: KortixTheme[] = [
  {
    id: 'graphite',
    name: 'Classic',
    accentColor: '#737373',
    description: 'Pure black & white, zero accent — Swiss minimalism',
  },
  {
    id: 'teal',
    name: 'Teal',
    accentColor: '#22808D',
    description: 'Black & white with turquoise accent',
  },
  {
    id: 'amber',
    name: 'Amber',
    accentColor: '#D4A017',
    description: 'Black & white with golden yellow accent',
  },
  {
    id: 'rose',
    name: 'Rose',
    accentColor: '#D14D72',
    description: 'Black & white with soft rose accent',
  },
  {
    id: 'violet',
    name: 'Violet',
    accentColor: '#7C5CFC',
    description: 'Black & white with electric purple accent',
  },
  {
    id: 'emerald',
    name: 'Emerald',
    accentColor: '#2D9F6F',
    description: 'Black & white with rich green accent',
  },
  {
    id: 'neon',
    name: 'Neon',
    accentColor: '#E8E000',
    description: 'Black & white with neon yellow accent',
  },
];

export function getThemeById(id: string): KortixTheme | undefined {
  return THEMES.find((t) => t.id === id);
}

/** Returns the CSS class name for a theme, or undefined for the default theme */
export function getThemeClassName(id: string): string | undefined {
  if (id === DEFAULT_THEME_ID) return undefined;
  return `theme-${id}`;
}

/** Returns all non-default theme class names (for cleanup) */
export function getAllThemeClassNames(): string[] {
  return THEMES.filter((t) => t.id !== DEFAULT_THEME_ID).map(
    (t) => `theme-${t.id}`
  );
}
