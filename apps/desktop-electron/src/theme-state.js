const THEMES = new Set(['light', 'dark', 'system']);

function normalizeTheme(theme) {
  return THEMES.has(theme) ? theme : 'system';
}

function backgroundForTheme(theme, shouldUseDarkColors) {
  const normalized = normalizeTheme(theme);
  const dark = normalized === 'dark' || (normalized === 'system' && shouldUseDarkColors);
  return dark ? '#0a0a0a' : '#ffffff';
}

module.exports = { normalizeTheme, backgroundForTheme };
