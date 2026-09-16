import { describe, expect, test } from 'bun:test';
import { transformSync } from '@babel/core';
import fs from 'fs';
import path from 'path';
import plugin from './deep-icon-imports.js';

const MOBILE_ROOT = path.resolve(__dirname, '..');

function transform(code: string): string {
  const out = transformSync(code, {
    babelrc: false,
    configFile: false,
    filename: path.join(__dirname, 'fixture.tsx'),
    parserOpts: { plugins: ['jsx', 'typescript'] },
    plugins: [plugin],
  });
  if (!out || !out.code) throw new Error('transform produced no output');
  return out.code;
}

describe('deep-icon-imports: lucide-react-native', () => {
  test('rewrites named imports into per-icon deep default imports', () => {
    const code = transform(`import { WifiOff, AlertCircle } from 'lucide-react-native';`);
    expect(code).toContain(`import WifiOff from "lucide-react-native/dist/esm/icons/wifi-off";`);
    // AlertCircle is a deprecated alias for CircleAlert; both are backed by the
    // same file (icons/circle-alert.js) per the installed package's barrel.
    expect(code).toContain(`import AlertCircle from "lucide-react-native/dist/esm/icons/circle-alert";`);
    expect(code).not.toContain(`from "lucide-react-native";`);
  });

  test('resolves aliases (XIcon / LucideX / renamed icons) to the same file as the canonical name', () => {
    const canonical = transform(`import { X } from 'lucide-react-native';`);
    const iconAlias = transform(`import { XIcon } from 'lucide-react-native';`);
    const lucideAlias = transform(`import { LucideX } from 'lucide-react-native';`);
    const target = `from "lucide-react-native/dist/esm/icons/x";`;
    expect(canonical).toContain(target);
    expect(iconAlias).toContain(target);
    expect(lucideAlias).toContain(target);
  });

  test('handles `import { X as Y }` and emits the local (aliased) name', () => {
    const code = transform(`import { X as CloseIcon } from 'lucide-react-native';`);
    expect(code).toContain(`import CloseIcon from "lucide-react-native/dist/esm/icons/x";`);
  });

  test('leaves a mixed value + untyped-type specifier list correct: known names rewritten, unknown name kept on root', () => {
    // Real pattern in this codebase (components/status/AlertBanner.tsx): LucideIcon
    // is a type but not marked `type` here. It is not a real runtime export, so it
    // is not in the map and must stay on the root import (preset-typescript elides
    // it later, based on usage, same as it does today).
    const code = transform(
      `import { X, ExternalLink, LucideIcon } from 'lucide-react-native';\nconst Icon: LucideIcon = X;`,
    );
    expect(code).toContain(`import X from "lucide-react-native/dist/esm/icons/x";`);
    expect(code).toContain(`import ExternalLink from "lucide-react-native/dist/esm/icons/external-link";`);
    expect(code).toContain(`import { LucideIcon } from 'lucide-react-native';`);
  });

  test('leaves `import type { ... }` declarations untouched', () => {
    // Untouched nodes keep their original raw text (including quote style) —
    // the plugin never visits their StringLiteral, so the generator preserves it.
    const code = transform(`import type { LucideIcon } from 'lucide-react-native';`);
    expect(code).toBe(`import type { LucideIcon } from 'lucide-react-native';`);
  });

  test('leaves an inline `type` specifier on the root import, rewrites the value specifiers around it', () => {
    const code = transform(`import { FilePlus, FileMinus, type LucideIcon } from 'lucide-react-native';`);
    expect(code).toContain(`import FilePlus from "lucide-react-native/dist/esm/icons/file-plus";`);
    expect(code).toContain(`import FileMinus from "lucide-react-native/dist/esm/icons/file-minus";`);
    expect(code).toContain(`import { type LucideIcon } from 'lucide-react-native';`);
  });

  test('leaves an unknown/unmapped name on the root import instead of crashing', () => {
    const code = transform(`import { TotallyNotARealIconXYZ } from 'lucide-react-native';`);
    expect(code).toBe(`import { TotallyNotARealIconXYZ } from 'lucide-react-native';`);
  });

  test('does not rewrite `export ... from` re-exports', () => {
    const code = transform(`export { X } from 'lucide-react-native';`);
    expect(code).toBe(`export { X } from 'lucide-react-native';`);
  });

  test('leaves imports from unrelated packages untouched', () => {
    const code = transform(`import { X } from 'some-other-package';`);
    expect(code).toBe(`import { X } from 'some-other-package';`);
  });
});

describe('deep-icon-imports: @expo/vector-icons', () => {
  test('rewrites named icon-set imports into deep default imports', () => {
    const code = transform(`import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';`);
    expect(code).toContain(`import Ionicons from "@expo/vector-icons/Ionicons";`);
    expect(code).toContain(`import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";`);
    expect(code).not.toContain(`from "@expo/vector-icons";`);
  });

  test('every deep path in the built map resolves via require.resolve from apps/mobile', () => {
    const maps = (plugin as any).getMaps();
    const vectorMap: Map<string, string> = maps.get((plugin as any).VECTOR_ICONS_PACKAGE);
    expect(vectorMap.size).toBeGreaterThan(0);
    expect(vectorMap.get('Ionicons')).toBe('@expo/vector-icons/Ionicons');
    for (const deepPath of vectorMap.values()) {
      expect(() => require.resolve(deepPath, { paths: [MOBILE_ROOT] })).not.toThrow();
    }
  });
});

describe('deep-icon-imports: map coverage', () => {
  test('lucide map has one entry per icon file, covering common aliases, and every path resolves', () => {
    const maps = (plugin as any).getMaps();
    const lucideMap: Map<string, string> = maps.get((plugin as any).LUCIDE_PACKAGE);
    // The codebase uses 245 distinct icon names (per audit finding C5); the full
    // package ships far more once aliases are counted.
    expect(lucideMap.size).toBeGreaterThan(1000);
    expect(lucideMap.has('icons')).toBe(false); // aggregate namespace export, not a per-icon default
    expect(lucideMap.has('createLucideIcon')).toBe(false); // utility export, not a per-icon default
    expect(lucideMap.has('Icon')).toBe(false); // utility export, not a per-icon default

    let checked = 0;
    for (const deepPath of lucideMap.values()) {
      expect(() => require.resolve(deepPath, { paths: [MOBILE_ROOT] })).not.toThrow();
      checked += 1;
    }
    expect(checked).toBe(lucideMap.size);
  });
});

describe('deep-icon-imports: whole-app check', () => {
  const SOURCE_DIRS = ['app', 'components', 'lib', 'hooks', 'contexts', 'providers', 'stores'];
  // Deliberately excluded from the map (see deep-icon-imports.js): the aggregate
  // `icons` namespace and the `createLucideIcon`/`Icon` utility exports. A bare
  // VALUE import of any of these from the root still loads all ~1,638 icon
  // modules, so the whole-app check must catch it even though the plugin itself
  // correctly leaves it alone.
  const UNMAPPED_LUCIDE_VALUE_NAMES = new Set(['icons', 'createLucideIcon', 'Icon']);

  function listSourceFiles(): string[] {
    const files: string[] = [];
    for (const dir of SOURCE_DIRS) {
      const abs = path.join(MOBILE_ROOT, dir);
      if (!fs.existsSync(abs)) continue;
      walk(abs, files);
    }
    return files;
  }

  function walk(dir: string, out: string[]) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, out);
      } else if (/\.(ts|tsx)$/.test(entry.name)) {
        out.push(full);
      }
    }
  }

  test('every real source file transforms to resolvable deep imports with no remaining mapped value on the root import', () => {
    const maps = (plugin as any).getMaps();
    const lucideMap: Map<string, string> = maps.get((plugin as any).LUCIDE_PACKAGE);
    const vectorMap: Map<string, string> = maps.get((plugin as any).VECTOR_ICONS_PACKAGE);

    const files = listSourceFiles();
    expect(files.length).toBeGreaterThan(400);

    let rewrittenCount = 0;
    const failures: string[] = [];

    for (const file of files) {
      const source = fs.readFileSync(file, 'utf8');
      if (!source.includes('lucide-react-native') && !source.includes('@expo/vector-icons')) continue;

      let out;
      try {
        out = transformSync(source, {
          babelrc: false,
          configFile: false,
          filename: file,
          ast: true,
          parserOpts: { plugins: ['jsx', 'typescript'] },
          plugins: [plugin],
        });
      } catch (error: any) {
        failures.push(`${file}: parse/transform error: ${error.message}`);
        continue;
      }
      const body = out?.ast?.program?.body ?? [];

      // Inspect the output AST directly (not the printed text) so comments and
      // string literals that merely *look* like an import statement (this file's
      // own JSDoc examples, for instance) can never be mistaken for real code.
      for (const node of body) {
        if (node.type !== 'ImportDeclaration') continue;
        const source_ = node.source.value as string;
        const isLucideDeep = source_.startsWith('lucide-react-native/');
        const isVectorDeep = source_.startsWith('@expo/vector-icons/');
        if (isLucideDeep || isVectorDeep) {
          rewrittenCount += 1;
          try {
            require.resolve(source_, { paths: [MOBILE_ROOT] });
          } catch {
            failures.push(`${file}: emitted unresolvable deep import "${source_}"`);
          }
          continue;
        }
        if (source_ !== 'lucide-react-native' && source_ !== '@expo/vector-icons') continue;
        const map = source_ === 'lucide-react-native' ? lucideMap : vectorMap;
        for (const specifier of node.specifiers) {
          if (specifier.type !== 'ImportSpecifier') continue;
          if (specifier.importKind === 'type') continue; // explicit `type X`, not a value import
          const importedName =
            specifier.imported.type === 'Identifier' ? specifier.imported.name : specifier.imported.value;
          if (map.has(importedName)) {
            failures.push(
              `${file}: "${importedName}" left on the root ${source_} import despite being in the deep-import map`,
            );
          }
          // These three are deliberately excluded from the map (they load the
          // barrel's aggregate/utility exports, not a single icon), but a bare
          // VALUE import of any of them still re-evaluates the whole barrel —
          // that is a real regression, not something the plugin can fix by
          // rewriting, so it must fail loudly here instead of passing silently.
          if (source_ === 'lucide-react-native' && UNMAPPED_LUCIDE_VALUE_NAMES.has(importedName)) {
            failures.push(
              `${file}: value import of "${importedName}" from root lucide-react-native reloads the full barrel`,
            );
          }
        }
      }
    }

    if (failures.length > 0) {
      throw new Error(`${failures.length} failure(s):\n${failures.join('\n')}`);
    }
    expect(rewrittenCount).toBeGreaterThan(150);
  });
});
