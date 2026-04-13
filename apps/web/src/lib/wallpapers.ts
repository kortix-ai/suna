export type WallpaperType = 'svg' | 'symbol' | 'aurora' | 'image';

export interface Wallpaper {
  id: string;
  name: string;
  type: WallpaperType;
  /** For 'svg' wallpapers — path to the SVG file */
  svgUrl?: string;
  /** For 'symbol' wallpapers — path to the symbol SVG shown centered at low opacity */
  symbolUrl?: string;
  /** For 'image' wallpapers — path to the light-mode image */
  lightUrl?: string;
  /** For 'image' wallpapers — path to the dark-mode image */
  darkUrl?: string;
  /** Small thumbnail for the picker */
  thumbnailUrl: string;
}

export const DEFAULT_WALLPAPER_ID = 'brandmark';

export const WALLPAPERS: Wallpaper[] = [
  {
    id: 'brandmark',
    name: 'Brandmark',
    type: 'svg',
    svgUrl: '/kortix-brandmark-bg.svg',
    thumbnailUrl: '/kortix-brandmark-bg.svg',
  },
  {
    id: 'symbol',
    name: 'Symbol',
    type: 'symbol',
    symbolUrl: '/kortix-symbol.svg',
    thumbnailUrl: '/kortix-symbol.svg',
  },
  {
    id: 'aurora',
    name: 'Aurora',
    type: 'aurora',
    svgUrl: '/kortix-logomark-white.svg',
    thumbnailUrl: '/kortix-logomark-white.svg',
  },
];

export function getWallpaperById(id: string): Wallpaper {
  return WALLPAPERS.find((w) => w.id === id) ?? WALLPAPERS[0];
}
