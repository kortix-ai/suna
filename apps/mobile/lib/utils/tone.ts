import { useColorScheme } from 'nativewind';

/**
 * The one tone read for the session UI: `colorScheme === 'dark' ? 'dark' :
 * 'light'` (null renders as light). Components use `THEME[tone]` instead of
 * hand-rolling the ternary per call site.
 *
 * It lives in its own module so the real `theme.ts` stays loadable by its
 * test without the native `nativewind` graph (which bun cannot parse
 * outside Metro); test fakes mock `@/lib/utils/tone` with `useTone`.
 */
export type Tone = 'light' | 'dark';

export function useTone(): Tone {
  const { colorScheme } = useColorScheme();
  return colorScheme === 'dark' ? 'dark' : 'light';
}
