export type WallpaperType = 'svg' | 'shader' | 'image' | 'none';

export interface Wallpaper {
  id: 'brandmark' | 'nebula' | 'silk' | 'dither' | 'grain' | 'neuro' | 'blank';
  name: string;
  type: WallpaperType;
  /** For 'svg' wallpapers — path to the SVG file */
  svgUrl?: string;
  /** For 'image' wallpapers — path to the light-mode image */
  lightUrl?: string;
  /** For 'image' wallpapers — path to the dark-mode image */
  darkUrl?: string;
  /** Small thumbnail for the picker */
  thumbnailUrl?: string;
  /**
   * Pre-rendered picker thumbnails per theme. Shader wallpapers use these
   * in the settings grid so only the wallpaper actually applied to the
   * page runs a live canvas.
   */
  thumbs?: { dark: string; light: string };
}

export const DEFAULT_WALLPAPER_ID = 'dither';

function shaderThumbs(id: Wallpaper['id']): Wallpaper['thumbs'] {
  return {
    dark: `/wallpapers/${id}-dark.jpg`,
    light: `/wallpapers/${id}-light.jpg`,
  };
}

export const WALLPAPERS: Wallpaper[] = [
  {
    id: 'dither',
    name: 'Dither',
    type: 'shader',
    thumbs: shaderThumbs('dither'),
  },
  {
    id: 'brandmark',
    name: 'Brandmark',
    type: 'svg',
    svgUrl: '/kortix-brandmark-bg.svg',
    thumbnailUrl: '/kortix-brandmark-bg.svg',
  },
  {
    id: 'nebula',
    name: 'Pixel Beams',
    type: 'shader',
    thumbs: shaderThumbs('nebula'),
  },
  {
    id: 'silk',
    name: 'Silk',
    type: 'shader',
    thumbs: shaderThumbs('silk'),
  },
  {
    id: 'grain',
    name: 'Grain',
    type: 'shader',
    thumbs: shaderThumbs('grain'),
  },
  {
    id: 'neuro',
    name: 'Neuro',
    type: 'shader',
    thumbs: shaderThumbs('neuro'),
  },
  {
    id: 'blank',
    name: 'Blank',
    type: 'none',
  },
];

export function getWallpaperById(id: string): Wallpaper {
  return WALLPAPERS.find((w) => w.id === id) ?? WALLPAPERS[0];
}
