import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * css-interop wraps React Native's `Pressable` and drops a function `style`
 * (`style={({ pressed }) => …}`) on device, with all layout inside it. Use
 * `PressableSurface` instead. This guard fails when a file under `app/` or
 * `components/` imports `Pressable` from `react-native` and passes it a
 * function style again. (`react-native-gesture-handler`'s `Pressable` is
 * not wrapped, so it is allowed.)
 */

const APP_ROOT = join(import.meta.dir, '..', '..');
const GUARDED_DIRS = ['app', 'components'].map((dir) => join(APP_ROOT, dir));

const RN_PRESSABLE_IMPORT = /import\s*\{[^}]*\bPressable\b[^}]*\}\s*from\s*['"]react-native['"]/;
/** A `<Pressable` tag (not `<PressableSurface`) whose props include a function style. */
const FUNCTION_STYLE = /<Pressable(?![\w.])[^<]*?style=\{\s*\(\s*\{\s*pressed\s*\}\s*\)\s*=>/;

export function hasDroppedPressableStyle(source: string): boolean {
  return RN_PRESSABLE_IMPORT.test(source) && FUNCTION_STYLE.test(source);
}

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) files.push(path);
  }
  return files;
}

describe('pressable function-style guard', () => {
  test('detects a react-native Pressable with a function style', () => {
    const source = "import { Pressable } from 'react-native';\n<Pressable style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1 })} />";
    expect(hasDroppedPressableStyle(source)).toBe(true);
  });

  test('allows gesture-handler Pressable and PressableSurface', () => {
    expect(
      hasDroppedPressableStyle(
        "import { Pressable } from 'react-native-gesture-handler';\n<Pressable style={({ pressed }) => ({})} />",
      ),
    ).toBe(false);
    expect(
      hasDroppedPressableStyle(
        "import { Pressable } from 'react-native';\n<Pressable onPress={go} />\n<PressableSurface style={({ pressed }) => ({})} />",
      ),
    ).toBe(false);
  });

  test('no app or component file passes a function style to a react-native Pressable', () => {
    const offenders = GUARDED_DIRS.flatMap(sourceFiles)
      .filter((path) => hasDroppedPressableStyle(readFileSync(path, 'utf8')))
      .map((path) => relative(APP_ROOT, path));
    expect(offenders).toEqual([]);
  });
});
