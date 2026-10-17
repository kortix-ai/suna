const terminalThemeBackgrounds = require('./kortix-theme-backgrounds.json');

const THEMES = new Set(['light', 'dark', 'system']);

/**
 * Launch backgrounds — the web app's `--background` for each interface theme
 * (apps/web/src/app/globals.css, "Interface themes"). The window paints this
 * before the page does, so it must match the canvas or every launch flashes.
 *
 * The Kortix-designed palettes are hand-written here; the 112 generated
 * generated Kortix themes (apps/web/src/lib/kortix-themes.generated.json)
 * are merged in from `kortix-theme-backgrounds.json`, which is regenerated
 * alongside that file.
 */
const LIGHT_BACKGROUNDS = {
  light: '#F0F0F0',
  'pure-light': '#FFFFFF',
  ...terminalThemeBackgrounds.light,
};
const DARK_BACKGROUNDS = {
  dark: '#090909',
  'pure-dark': '#0A0A0A',
  ...terminalThemeBackgrounds.dark,
};
const DEFAULT_CHOICE = { light: 'pure-light', dark: 'pure-dark' };

/** Ids stored by earlier builds that now live under a terminal-theme id. */
const LEGACY_DARK_THEME_IDS = { jellybean: 'jellybeans-default' };

function normalizeTheme(theme) {
  return THEMES.has(theme) ? theme : 'light';
}

/** Unknown or missing palettes fall back to Pure light / Pure dark. */
function normalizeChoice(choice) {
  const source = choice && typeof choice === 'object' ? choice : {};
  const dark =
    typeof source.dark === 'string' ? (LEGACY_DARK_THEME_IDS[source.dark] ?? source.dark) : source.dark;
  return {
    light: Object.hasOwn(LIGHT_BACKGROUNDS, source.light) ? source.light : DEFAULT_CHOICE.light,
    dark: Object.hasOwn(DARK_BACKGROUNDS, dark) ? dark : DEFAULT_CHOICE.dark,
  };
}

function backgroundForTheme(theme, shouldUseDarkColors, choice) {
  const normalized = normalizeTheme(theme);
  const dark = normalized === 'dark' || (normalized === 'system' && shouldUseDarkColors);
  const { light: lightId, dark: darkId } = normalizeChoice(choice);
  return dark ? DARK_BACKGROUNDS[darkId] : LIGHT_BACKGROUNDS[lightId];
}

module.exports = { normalizeTheme, normalizeChoice, backgroundForTheme };
