'use client';

import { createContext, useContext } from 'react';

/**
 * The full-bleed background layer that {@link SessionLayout} mounts at the very
 * root of the session view — it spans the ENTIRE session width, behind the
 * resizable split. {@link SessionChat} portals its welcome wallpaper into this
 * node (via {@link useSessionWallpaperLayer}) so the wallpaper always renders at
 * full session width and never shrinks or recrops when the side panel opens.
 *
 * Null on mobile / the standalone route where no layer is mounted — there
 * SessionChat falls back to rendering the wallpaper inline (the panel is already
 * full width in those layouts).
 */
export const SessionWallpaperLayerContext = createContext<HTMLElement | null>(null);

export function useSessionWallpaperLayer(): HTMLElement | null {
  return useContext(SessionWallpaperLayerContext);
}
