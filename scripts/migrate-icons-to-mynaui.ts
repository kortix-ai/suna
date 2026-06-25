#!/usr/bin/env bun
/**
 * Codemod: migrate apps/web from `lucide-react` + `react-icons` to
 * `@mynaui/icons-react`, preferring the Solid variants.
 *
 * Run:
 *   bun scripts/migrate-icons-to-mynaui.ts            # migrate apps/web in place
 *   bun scripts/migrate-icons-to-mynaui.ts --dry-run  # report only, no writes
 *
 * Strategy: rewrite ONLY import statements. Every migrated icon is imported
 * under an alias back to its original local identifier
 * (`CogSolid as Settings`), so JSX/usage sites are never touched — the safest
 * possible transform. Type-only imports (`LucideIcon`, react-icons `IconType`)
 * become the mynaui `Icon` type; `lucide-react/dynamic` is repointed at the
 * mynaui-backed resolver. The name mapping lives in the shared, app-importable
 * module `apps/web/src/lib/icon-migration-map.ts` (single source of truth).
 */
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  LUCIDE_TO_MYNAUI,
  REACT_ICONS_TO_MYNAUI,
  FORCED_MAPPINGS,
  FORCE_SOLID,
} from '../apps/web/src/lib/icon-migration-map';

const MYNAUI = '@mynaui/icons-react';
const DYNAMIC_IMPORT_PATH = '@/components/ui/dynamic-icon';

// `typescript` and the icon package are installed under apps/web (pnpm, not
// root-hoisted), so resolve both from there.
const REPO_ROOT = join(import.meta.dir, '..');
const webRequire = createRequire(join(REPO_ROOT, 'apps/web/package.json'));
const ts = webRequire('typescript') as typeof import('typescript');

// ---------------------------------------------------------------------------
// mynaui export surface (read from the installed package's .d.ts — no React import)
// ---------------------------------------------------------------------------
const MYNA_NAMES: ReadonlySet<string> = (() => {
  const entry = webRequire.resolve(MYNAUI); // .../dist/cjs/myna-icons-react.js
  const dtsPath = entry.replace(/dist[\\/].*$/, 'dist/myna-icons-react.d.ts');
  const dts = readFileSync(dtsPath, 'utf8');
  return new Set([...dts.matchAll(/declare const ([A-Za-z0-9]+)/g)].map(m => m[1]));
})();

function mynaTarget(base: string): { name: string; fallbackOutline: boolean } | null {
  // Default is the regular (outline) variant; only bases in FORCE_SOLID render
  // filled. Solid-only icons (no outline variant) still fall back to Solid.
  if (FORCE_SOLID.has(base) && MYNA_NAMES.has(`${base}Solid`)) return { name: `${base}Solid`, fallbackOutline: false };
  if (MYNA_NAMES.has(base)) return { name: base, fallbackOutline: false };
  if (MYNA_NAMES.has(`${base}Solid`)) return { name: `${base}Solid`, fallbackOutline: false };
  return null;
}

// ---------------------------------------------------------------------------
// transform
// ---------------------------------------------------------------------------
export interface MigrationNote {
  file: string;
  kind: 'lucide' | 'react-icons' | 'type' | 'dynamic';
  from: string;
  to: string;
  forced: boolean;
  fallbackOutline: boolean;
}

interface Spec {
  imported: string;
  local: string;
}

const specText = (s: Spec): string => (s.imported === s.local ? s.imported : `${s.imported} as ${s.local}`);
const dedupKey = (s: Spec): string => `${s.imported}|${s.local}`;

function dedup(specs: Spec[]): Spec[] {
  const seen = new Set<string>();
  const out: Spec[] = [];
  for (const s of specs) {
    if (seen.has(dedupKey(s))) continue;
    seen.add(dedupKey(s));
    out.push(s);
  }
  return out;
}

function renderImport(isType: boolean, specs: Spec[]): string {
  return `import ${isType ? 'type ' : ''}{ ${specs.map(specText).join(', ')} } from '${MYNAUI}';`;
}

function namedSpecs(node: ts.ImportDeclaration): Spec[] {
  const nb = node.importClause?.namedBindings;
  if (!nb || !ts.isNamedImports(nb)) return [];
  return nb.elements.map(el => ({
    imported: (el.propertyName ?? el.name).text,
    local: el.name.text,
  }));
}

export function transformSource(
  filePath: string,
  text: string,
): { code: string; changed: boolean; notes: MigrationNote[] } {
  const sf = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

  const edits: { start: number; end: number; newText: string }[] = [];
  const notes: MigrationNote[] = [];
  const valueAdds: Spec[] = [];
  const typeAdds: Spec[] = [];
  const removals: ts.ImportDeclaration[] = [];
  let existingValueMyna: ts.ImportDeclaration | undefined;
  let existingTypeMyna: ts.ImportDeclaration | undefined;

  const fail = (msg: string): never => {
    throw new Error(`[migrate-icons] ${filePath}: ${msg}`);
  };

  // Resolve a value icon's source name to its mynaui equivalent (Solid preferred).
  const resolveValue = (source: string, fromReactIcons: boolean): { name: string; forced: boolean; fallbackOutline: boolean } => {
    const map = fromReactIcons ? REACT_ICONS_TO_MYNAUI : LUCIDE_TO_MYNAUI;
    const base = map[source] ?? source;
    const t = mynaTarget(base);
    if (!t) fail(`no mynaui icon for '${source}' (base '${base}')`);
    return { name: t!.name, forced: FORCED_MAPPINGS.has(source), fallbackOutline: t!.fallbackOutline };
  };

  for (const stmt of sf.statements) {
    // ── Barrel re-exports: `export { A as B } from 'lucide-react' | 'react-icons/*'`
    if (
      ts.isExportDeclaration(stmt) &&
      stmt.moduleSpecifier &&
      ts.isStringLiteral(stmt.moduleSpecifier) &&
      stmt.exportClause &&
      ts.isNamedExports(stmt.exportClause)
    ) {
      const mod = stmt.moduleSpecifier.text;
      const isLucide = mod === 'lucide-react';
      const isReactIcons = mod.startsWith('react-icons/');
      if (!isLucide && !isReactIcons) continue;
      const allType = stmt.isTypeOnly;
      const specs: string[] = [];
      for (const el of stmt.exportClause.elements) {
        const source = (el.propertyName ?? el.name).text;
        const alias = el.name.text;
        const isType = allType || el.isTypeOnly || source === 'LucideIcon' || source === 'LucideProps';
        let newSource: string;
        if (isType || mod === 'react-icons/lib') {
          newSource = 'Icon';
          notes.push({ file: filePath, kind: 'type', from: source, to: 'Icon', forced: false, fallbackOutline: false });
        } else {
          const r = resolveValue(source, isReactIcons);
          newSource = r.name;
          notes.push({ file: filePath, kind: isReactIcons ? 'react-icons' : 'lucide', from: source, to: r.name, forced: r.forced, fallbackOutline: r.fallbackOutline });
        }
        const typePrefix = !allType && el.isTypeOnly ? 'type ' : '';
        specs.push(`${typePrefix}${newSource === alias ? newSource : `${newSource} as ${alias}`}`);
      }
      const text2 = `export ${allType ? 'type ' : ''}{ ${specs.join(', ')} } from '${MYNAUI}';`;
      edits.push({ start: stmt.getStart(sf), end: stmt.getEnd(), newText: text2 });
      continue;
    }

    if (!ts.isImportDeclaration(stmt)) continue;
    if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const mod = stmt.moduleSpecifier.text;
    const clause = stmt.importClause;

    if (mod === 'lucide-react') {
      removals.push(stmt);
      const typeOnly = !!clause?.isTypeOnly;
      const nb = clause?.namedBindings;
      if (!nb || !ts.isNamedImports(nb)) fail(`unsupported lucide-react import shape`);
      for (const el of (nb as ts.NamedImports).elements) {
        const imported = (el.propertyName ?? el.name).text;
        const local = el.name.text;
        // `LucideIcon` / `LucideProps` are types, even when imported without the
        // `type` keyword — always swap them to the mynaui `Icon` type.
        const isType = typeOnly || el.isTypeOnly || imported === 'LucideIcon' || imported === 'LucideProps';
        if (isType) {
          typeAdds.push({ imported: 'Icon', local });
          notes.push({ file: filePath, kind: 'type', from: imported, to: 'Icon', forced: false, fallbackOutline: false });
          continue;
        }
        if (!/^[A-Z]/.test(imported)) {
          fail(`unsupported lucide value import '${imported}' (e.g. the dynamic 'icons' registry) — migrate this file manually`);
        }
        const base = LUCIDE_TO_MYNAUI[imported] ?? imported;
        const t = mynaTarget(base);
        if (!t) fail(`no mynaui icon for lucide '${imported}' (base '${base}')`);
        valueAdds.push({ imported: t!.name, local });
        notes.push({ file: filePath, kind: 'lucide', from: imported, to: t!.name, forced: FORCED_MAPPINGS.has(imported), fallbackOutline: t!.fallbackOutline });
      }
    } else if (mod === 'lucide-react/dynamic') {
      // Repoint at the mynaui-backed resolver; keep the named bindings as-is.
      const ms = stmt.moduleSpecifier;
      edits.push({ start: ms.getStart(sf), end: ms.getEnd(), newText: `'${DYNAMIC_IMPORT_PATH}'` });
      for (const s of namedSpecs(stmt)) {
        notes.push({ file: filePath, kind: 'dynamic', from: `${s.imported} (lucide-react/dynamic)`, to: `${s.imported} (${DYNAMIC_IMPORT_PATH})`, forced: false, fallbackOutline: false });
      }
    } else if (mod === 'react-icons/lib') {
      removals.push(stmt);
      for (const el of namedSpecs(stmt)) {
        // The only export used here is the `IconType` prop type.
        typeAdds.push({ imported: 'Icon', local: el.local });
        notes.push({ file: filePath, kind: 'type', from: el.imported, to: 'Icon', forced: false, fallbackOutline: false });
      }
    } else if (mod.startsWith('react-icons/')) {
      removals.push(stmt);
      const typeOnly = !!clause?.isTypeOnly;
      for (const el of namedSpecs(stmt)) {
        if (typeOnly) {
          typeAdds.push({ imported: 'Icon', local: el.local });
          notes.push({ file: filePath, kind: 'type', from: el.imported, to: 'Icon', forced: false, fallbackOutline: false });
          continue;
        }
        const base = REACT_ICONS_TO_MYNAUI[el.imported] ?? el.imported;
        const t = mynaTarget(base);
        if (!t) fail(`no mynaui icon for react-icons '${el.imported}' (base '${base}')`);
        valueAdds.push({ imported: t!.name, local: el.local });
        notes.push({ file: filePath, kind: 'react-icons', from: el.imported, to: t!.name, forced: FORCED_MAPPINGS.has(el.imported), fallbackOutline: t!.fallbackOutline });
      }
    } else if (mod === MYNAUI) {
      if (clause?.isTypeOnly) existingTypeMyna ??= stmt;
      else existingValueMyna ??= stmt;
    }
  }

  // Merge into an existing mynaui import, or synthesize a new line at the first removal.
  const newLines: string[] = [];

  if (valueAdds.length) {
    if (existingValueMyna) {
      edits.push({
        start: existingValueMyna.getStart(sf),
        end: existingValueMyna.getEnd(),
        newText: renderImport(false, dedup([...namedSpecs(existingValueMyna), ...valueAdds])),
      });
    } else {
      newLines.push(renderImport(false, dedup(valueAdds)));
    }
  }
  if (typeAdds.length) {
    if (existingTypeMyna) {
      edits.push({
        start: existingTypeMyna.getStart(sf),
        end: existingTypeMyna.getEnd(),
        newText: renderImport(true, dedup([...namedSpecs(existingTypeMyna), ...typeAdds])),
      });
    } else {
      newLines.push(renderImport(true, dedup(typeAdds)));
    }
  }

  // Delete removed imports; the first one is replaced by the synthesized lines.
  removals.sort((a, b) => a.getStart(sf) - b.getStart(sf));
  removals.forEach((node, i) => {
    const start = node.getStart(sf);
    let end = node.getEnd();
    if (text[end] === '\n') end += 1; // consume trailing newline
    const newText = i === 0 && newLines.length ? `${newLines.join('\n')}\n` : '';
    edits.push({ start, end, newText });
  });

  if (!edits.length) return { code: text, changed: false, notes };

  edits.sort((a, b) => b.start - a.start);
  let out = text;
  for (const e of edits) out = out.slice(0, e.start) + e.newText + out.slice(e.end);
  return { code: out, changed: out !== text, notes };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
async function main() {
  const dryRun = process.argv.includes('--dry-run') || process.argv.includes('--report-only');
  const repoRoot = REPO_ROOT;
  const glob = new Bun.Glob('apps/web/src/**/*.{ts,tsx}');

  const allNotes: MigrationNote[] = [];
  const touched: string[] = [];
  const errors: string[] = [];

  for await (const rel of glob.scan({ cwd: repoRoot })) {
    const abs = join(repoRoot, rel);
    const src = readFileSync(abs, 'utf8');
    if (!src.includes('lucide-react') && !src.includes('react-icons')) continue;
    try {
      const { code, changed, notes } = transformSource(abs, src);
      if (notes.length) allNotes.push(...notes.map(n => ({ ...n, file: rel })));
      if (changed) {
        touched.push(rel);
        if (!dryRun) writeFileSync(abs, code);
      }
    } catch (err) {
      errors.push((err as Error).message);
    }
  }

  // Drop the now-unused deps when nothing is left importing them.
  const pkgPath = join(repoRoot, 'apps/web/package.json');
  const remaining = await (async () => {
    let count = 0;
    for await (const rel of new Bun.Glob('apps/web/src/**/*.{ts,tsx}').scan({ cwd: repoRoot })) {
      const s = readFileSync(join(repoRoot, rel), 'utf8');
      if (/from\s+['"]lucide-react['"]|from\s+['"]lucide-react\/|from\s+['"]react-icons\//.test(s)) count++;
    }
    return count;
  })();
  let depsRemoved = false;
  if (remaining === 0 && !errors.length && !dryRun) {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    for (const dep of ['lucide-react', 'react-icons']) {
      if (pkg.dependencies?.[dep]) { delete pkg.dependencies[dep]; depsRemoved = true; }
    }
    if (depsRemoved) writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  }

  writeReport(repoRoot, { allNotes, touched, errors, remaining, depsRemoved, dryRun });

  console.log(`${dryRun ? '[dry-run] ' : ''}files changed: ${touched.length}, icons migrated: ${allNotes.length}, forced: ${allNotes.filter(n => n.forced).length}, errors: ${errors.length}, lucide/react-icons imports remaining: ${remaining}`);
  if (errors.length) {
    console.error('\nFiles needing manual attention:');
    errors.forEach(e => console.error(`  - ${e}`));
    process.exitCode = 1;
  }
  console.log('Report: scripts/MIGRATION_REPORT.md');
}

function writeReport(
  repoRoot: string,
  d: { allNotes: MigrationNote[]; touched: string[]; errors: string[]; remaining: number; depsRemoved: boolean; dryRun: boolean },
) {
  const forced = d.allNotes.filter(n => n.forced);
  const fallback = d.allNotes.filter(n => n.fallbackOutline);
  const lines: string[] = [];
  lines.push('# Icon migration report', '');
  lines.push(`- Mode: ${d.dryRun ? 'dry-run (no files written)' : 'applied'}`);
  lines.push(`- Files changed: ${d.touched.length}`);
  lines.push(`- Icons migrated: ${d.allNotes.length}`);
  lines.push(`- Forced (no real mynaui equivalent — REVIEW): ${forced.length}`);
  lines.push(`- Outline fallbacks (no Solid variant): ${fallback.length}`);
  lines.push(`- lucide/react-icons imports remaining: ${d.remaining}`);
  lines.push(`- Deps removed from apps/web/package.json: ${d.depsRemoved ? 'yes' : 'no'}`);
  lines.push('');
  if (d.errors.length) {
    lines.push('## ⚠️ Files needing manual attention', '');
    d.errors.forEach(e => lines.push(`- ${e}`));
    lines.push('');
  }
  if (forced.length) {
    lines.push('## 🔍 Forced mappings — review these', '');
    lines.push('| original | mynaui | file |', '| --- | --- | --- |');
    forced.forEach(n => lines.push(`| \`${n.from}\` | \`${n.to}\` | ${n.file} |`));
    lines.push('');
  }
  if (fallback.length) {
    lines.push('## Outline fallbacks (no Solid variant available)', '');
    lines.push('| original | mynaui | file |', '| --- | --- | --- |');
    fallback.forEach(n => lines.push(`| \`${n.from}\` | \`${n.to}\` | ${n.file} |`));
    lines.push('');
  }
  lines.push('## All migrations', '');
  lines.push('| file | original | mynaui | kind |', '| --- | --- | --- | --- |');
  for (const n of d.allNotes) lines.push(`| ${n.file} | \`${n.from}\` | \`${n.to}\` | ${n.kind}${n.forced ? ' ⚠️' : ''} |`);
  lines.push('');
  writeFileSync(join(repoRoot, 'scripts/MIGRATION_REPORT.md'), lines.join('\n'));
}

if (import.meta.main) {
  await main();
}
