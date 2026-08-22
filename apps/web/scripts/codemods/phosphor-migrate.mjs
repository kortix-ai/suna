/* One-shot migration of icon imports to @phosphor-icons/react.
   Usage (from apps/web):  node scripts/codemods/phosphor-migrate.mjs [--dry]
   Rewrites import/export statements only, aliasing phosphor names back to the
   original local names so function bodies stay untouched. The single body edit:
   fill-intent locals get weight="fill" injected into their direct JSX usages.
   Fails loudly (writes nothing) if any name has no mapping. */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import * as phosphorAll from '@phosphor-icons/react';

import { FILL_INTENT_SOURCES, MANUAL_MAP, TYPE_MAP } from './phosphor-map.mjs';

const ROOT = join(process.cwd(), 'src');
const DRY = process.argv.includes('--dry');
const PHOSPHOR = new Set(Object.keys(phosphorAll));

const SKIP_FILES = new Set(
  [
    'components/ui/kortix-icons.ts',
    'components/ui/agent-avatar.tsx',
    'features/icon/icon.tsx',
    'components/brand/brand-logos.tsx',
    'lib/utils/icon-utils.ts',
  ].map((p) => join(ROOT, p)),
);

function libOf(spec) {
  if (spec === 'lucide-react' || spec.startsWith('lucide-react/')) return 'lucide-react';
  if (spec === 'react-icons' || spec.startsWith('react-icons/')) return 'react-icons';
  if (spec === '@mynaui/icons-react') return '@mynaui/icons-react';
  if (spec === '@icons-pack/react-simple-icons') return '@icons-pack/react-simple-icons';
  return null;
}

const errors = [];

function mapName(lib, name) {
  const typeTarget = TYPE_MAP[lib]?.[name];
  if (typeTarget) return { target: typeTarget, isType: true };
  const manual = MANUAL_MAP[lib]?.[name];
  if (manual) return { target: manual, isType: false };
  if (PHOSPHOR.has(`${name}Icon`)) return { target: `${name}Icon`, isType: false };
  errors.push(`no mapping: ${lib} -> ${name}`);
  return { target: name, isType: false };
}

const STMT_RE = /(import|export)(\s+type)?\s*\{([^}]*)\}\s*from\s*(['"])([^'"]+)\4;?/g;

function rewriteStatement(kind, typeOnly, specifierList, lib, fillLocals) {
  // Strip full-line comments inside the specifier block (e.g. section
  // headers like `// Navigation`) so they don't get merged with the
  // following specifier by the comma split below.
  const withoutCommentLines = specifierList
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  const specs = withoutCommentLines
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const out = [];
  for (const raw of specs) {
    const inlineType = /^type\s/.test(raw);
    const clean = raw.replace(/^type\s+/, '');
    const [name, local = name] = clean.split(/\s+as\s+/).map((s) => s.trim());
    const mapped = mapName(lib, name);
    const spec = mapped.target === local ? local : `${mapped.target} as ${local}`;
    out.push(inlineType || (mapped.isType && !typeOnly) ? `type ${spec}` : spec);
    if (FILL_INTENT_SOURCES.has(name)) fillLocals.push(local);
  }
  const typePrefix = typeOnly ? ' type' : '';
  return `${kind}${typePrefix} { ${out.join(', ')} } from '@phosphor-icons/react';`;
}

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (/\.(ts|tsx|js|jsx|mts|mjs)$/.test(entry)) yield path;
  }
}

let changed = 0;
const pending = [];
for (const file of walk(ROOT)) {
  if (SKIP_FILES.has(file)) continue;
  const src = readFileSync(file, 'utf8');
  const fillLocals = [];
  const next = src.replace(STMT_RE, (full, kind, typeKw, specs, _q, spec) => {
    const lib = libOf(spec);
    if (!lib) return full;
    return rewriteStatement(kind, Boolean(typeKw), specs, lib, fillLocals);
  });
  if (next === src) continue;
  let out = next;
  for (const local of new Set(fillLocals)) {
    out = out.replace(new RegExp(`<${local}(?=[\\s/>])`, 'g'), `<${local} weight="fill"`);
    const refRe = new RegExp(`(?<![.<\\w$])${local}(?![\\w$])`);
    out.split('\n').forEach((line, i) => {
      if (line.includes('@phosphor-icons/react') || line.includes(`<${local}`)) return;
      if (refRe.test(line)) {
        console.log(
          `REVIEW ${relative(process.cwd(), file)}:${i + 1} — ${local} used as a reference; weight="fill" not applied`,
        );
      }
    });
  }
  changed += 1;
  pending.push([file, out]);
  if (DRY) console.log(`would rewrite ${relative(process.cwd(), file)}`);
}

if (errors.length) {
  console.error(`ABORT — ${errors.length} unmapped name(s):`);
  for (const e of [...new Set(errors)]) console.error(`  ${e}`);
  process.exit(1);
}

if (!DRY) for (const [file, out] of pending) writeFileSync(file, out);
console.log(`${DRY ? 'would rewrite' : 'rewrote'} ${changed} files`);
