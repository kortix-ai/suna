/** The genui map basemap, pure so the pending block can read it without loading the map. */

const OPENFREEMAP = 'https://tiles.openfreemap.org/styles';

/**
 * The basemap, as web's `mapStyles()`: OpenFreeMap by default (free for commercial use, no key, no
 * request limit; its style carries the OpenMapTiles and OpenStreetMap attribution). The env var
 * overrides it, for both themes; `off` draws no map, only the place rows.
 */
export function mapStyleUrl(dark: boolean, env: string | undefined = process.env.EXPO_PUBLIC_GENUI_MAP_STYLE_URL): string | null {
  if (env === 'off') return null;
  if (env) return env;
  return `${OPENFREEMAP}/${dark ? 'dark' : 'positron'}`;
}
