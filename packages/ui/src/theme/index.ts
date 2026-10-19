// @kortix/ui/theme: the typed theme API. theme.ts is server-safe;
// ThemeScope is a client component.
export {
  THEME_COLOR_VARS,
  themeToCss,
  themeToCssVars,
  type KortixTheme,
  type ThemeColor,
  type ThemeColors,
  type ThemeCssVars,
  type ThemeDurationStep,
  type ThemeEasing,
  type ThemeShadowStep,
  type ThemeTextStep,
} from './theme';
export { ThemeScope, type ThemeScopeProps } from './theme-scope';
