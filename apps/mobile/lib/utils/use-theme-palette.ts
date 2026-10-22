/**
 * The one useColorScheme + THEME pick. Components that need the active palette
 * import this instead of writing the ternary themselves.
 *
 * Lives beside — not inside — `lib/utils/theme.ts` on purpose: the hook needs
 * `useColorScheme` from 'nativewind', whose module graph reaches react-native's
 * unparsable-for-bun entry, while `theme.ts` must stay bun-testable (its test
 * pins the real THEME, and several test files import it unmocked — see
 * `components/session/composer-status-pill.test.tsx`'s module-registry note).
 */
import { useColorScheme } from 'nativewind';
import { THEME } from '@/lib/utils/theme';

export function useThemePalette(): (typeof THEME)['dark'] | (typeof THEME)['light'] {
  const { colorScheme } = useColorScheme();
  return colorScheme === 'dark' ? THEME.dark : THEME.light;
}
