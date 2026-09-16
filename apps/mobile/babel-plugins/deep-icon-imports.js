'use strict';

/**
 * Rewrites named value imports from 'lucide-react-native' and '@expo/vector-icons'
 * into per-icon deep default imports, so Metro evaluates only the icon modules a
 * file actually uses instead of the whole barrel:
 *  - lucide-react-native: root import evaluates all ~1,638 icon modules.
 *  - @expo/vector-icons: root import (`build/IconsLazy.js`) eagerly requires all
 *    19 icon sets and their glyph JSON (544 KB).
 *
 * The name -> deep-import-path maps are built once, at plugin load, by parsing the
 * installed package's own barrel file (its `export { default as Name } from
 * './somewhere.js'` statements). This keeps aliases (XIcon, LucideX, renamed
 * icons) mapped to the correct file without hand-deriving kebab-case names, and
 * keeps the map in sync with whatever icon set the installed package version
 * ships. `export ... from` re-exports are never rewritten (only `ImportDeclaration`
 * nodes are visited).
 */

const fs = require('fs');
const path = require('path');
const { parseSync } = require('@babel/core');

const LUCIDE_PACKAGE = 'lucide-react-native';
const VECTOR_ICONS_PACKAGE = '@expo/vector-icons';

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function parseModule(file) {
  return parseSync(fs.readFileSync(file, 'utf8'), {
    babelrc: false,
    configFile: false,
    sourceType: 'module',
    filename: file,
  });
}

// Only a default re-export (`export { default as Name } from './somewhere.js'`)
// describes a single importable value backed by exactly one file. Anything else
// (namespace re-exports such as `export { index as icons }`, local declarations)
// is skipped by the callback's caller via the sourceValue/exportedName it gets.
function eachDefaultReexport(ast, callback) {
  for (const node of ast.program.body) {
    if (node.type !== 'ExportNamedDeclaration' || !node.source) continue;
    for (const specifier of node.specifiers) {
      if (specifier.type !== 'ExportSpecifier') continue;
      if (specifier.local.type !== 'Identifier' || specifier.local.name !== 'default') continue;
      const exportedName =
        specifier.exported.type === 'Identifier' ? specifier.exported.name : specifier.exported.value;
      callback(exportedName, node.source.value);
    }
  }
}

function buildLucideMap(basedir) {
  const map = new Map();
  const pkgJsonPath = require.resolve(`${LUCIDE_PACKAGE}/package.json`, { paths: [basedir] });
  const pkgDir = path.dirname(pkgJsonPath);
  const pkgJson = readJson(pkgJsonPath);
  const entryRelative = pkgJson['react-native'] || pkgJson.module || pkgJson.main;
  const entryAbsolute = path.join(pkgDir, entryRelative);
  const entryDir = path.dirname(entryAbsolute);
  const ast = parseModule(entryAbsolute);

  eachDefaultReexport(ast, (exportedName, sourceValue) => {
    // Only true per-icon files (./icons/*.js) become deep imports. Utility
    // exports re-exported the same way (createLucideIcon, Icon) stay on the root
    // import; they are not worth a dedicated deep path and are rarely used.
    if (!sourceValue.startsWith('./icons/')) return;
    const resolvedAbsolute = path.join(entryDir, sourceValue);
    const subpath = path
      .relative(pkgDir, resolvedAbsolute)
      .split(path.sep)
      .join('/')
      .replace(/\.js$/, '');
    map.set(exportedName, `${LUCIDE_PACKAGE}/${subpath}`);
  });

  return map;
}

function buildVectorIconsMap(basedir) {
  const map = new Map();
  const pkgJsonPath = require.resolve(`${VECTOR_ICONS_PACKAGE}/package.json`, { paths: [basedir] });
  const pkgDir = path.dirname(pkgJsonPath);
  const pkgJson = readJson(pkgJsonPath);
  const entryRelative = pkgJson.module || pkgJson.main;
  const entryAbsolute = path.join(pkgDir, entryRelative);
  const ast = parseModule(entryAbsolute);

  eachDefaultReexport(ast, (exportedName) => {
    // Each icon set (and each createXIconSet helper) is republished at the
    // package root as its own deep-importable module; verify it exists in
    // node_modules before rewriting to it.
    const deepFile = path.join(pkgDir, `${exportedName}.js`);
    if (!fs.existsSync(deepFile)) return;
    map.set(exportedName, `${VECTOR_ICONS_PACKAGE}/${exportedName}`);
  });

  return map;
}

let cachedMaps = null;

function getMaps() {
  if (cachedMaps) return cachedMaps;
  const basedir = __dirname;
  const maps = new Map();

  function buildOrWarn(packageName, build) {
    try {
      const map = build(basedir);
      if (map.size === 0) {
        // eslint-disable-next-line no-console
        console.warn(
          `[deep-icon-imports] built an empty map for "${packageName}"; its imports will stay on the root barrel (no per-icon deep import applied). The package's barrel shape may have changed.`,
        );
      }
      return map;
    } catch (error) {
      // Package not resolvable, or its barrel no longer parses (removed,
      // renamed, or its shape changed on an upgrade): leave that package's
      // imports untouched instead of failing the whole build, but say so —
      // a silent no-op here re-introduces the full-barrel evaluation cost
      // this plugin exists to remove.
      // eslint-disable-next-line no-console
      console.warn(`[deep-icon-imports] failed to build the deep-import map for "${packageName}": ${error.message}`);
      return new Map();
    }
  }

  maps.set(LUCIDE_PACKAGE, buildOrWarn(LUCIDE_PACKAGE, buildLucideMap));
  maps.set(VECTOR_ICONS_PACKAGE, buildOrWarn(VECTOR_ICONS_PACKAGE, buildVectorIconsMap));
  cachedMaps = maps;
  return maps;
}

function deepIconImports({ types: t }) {
  return {
    name: 'deep-icon-imports',
    visitor: {
      ImportDeclaration(importPath) {
        const source = importPath.node.source.value;
        const map = getMaps().get(source);
        if (!map || map.size === 0) return;
        // A whole `import type { ... } from '...'` declaration has no runtime
        // specifier to rewrite.
        if (importPath.node.importKind === 'type') return;

        const keepSpecifiers = [];
        const newDeclarations = [];

        for (const specifier of importPath.node.specifiers) {
          if (specifier.type !== 'ImportSpecifier') {
            // Default / namespace imports from these packages are not per-icon
            // named value imports; leave them as-is.
            keepSpecifiers.push(specifier);
            continue;
          }
          if (specifier.importKind === 'type') {
            // Explicit `import { type X }` specifier: type-only, leave in place.
            keepSpecifiers.push(specifier);
            continue;
          }
          const importedName =
            specifier.imported.type === 'Identifier' ? specifier.imported.name : specifier.imported.value;
          const deepPath = map.get(importedName);
          if (!deepPath) {
            // Not a known icon export (e.g. an untyped `LucideIcon` type
            // specifier, or a name the plugin doesn't recognize): keep it on
            // the root import so downstream type-only elision still applies.
            keepSpecifiers.push(specifier);
            continue;
          }
          newDeclarations.push(
            t.importDeclaration(
              [t.importDefaultSpecifier(t.identifier(specifier.local.name))],
              t.stringLiteral(deepPath),
            ),
          );
        }

        if (newDeclarations.length === 0) return;

        if (keepSpecifiers.length === 0) {
          importPath.replaceWithMultiple(newDeclarations);
        } else {
          importPath.node.specifiers = keepSpecifiers;
          importPath.insertAfter(newDeclarations);
        }
      },
    },
  };
}

deepIconImports.buildLucideMap = buildLucideMap;
deepIconImports.buildVectorIconsMap = buildVectorIconsMap;
deepIconImports.getMaps = getMaps;
deepIconImports.LUCIDE_PACKAGE = LUCIDE_PACKAGE;
deepIconImports.VECTOR_ICONS_PACKAGE = VECTOR_ICONS_PACKAGE;

module.exports = deepIconImports;
