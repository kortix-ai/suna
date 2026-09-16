import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Guards the icon system (see `lib/icons/index.ts`):
 * 1. No file imports a retired icon library.
 * 2. Only `lib/icons/` imports `phosphor-react-native`.
 * 3. Every registry export has a consumer — the registry IS the icon bundle.
 * 4. No icon JSX outside `lib/icons/` passes a `weight` other than `"fill"`.
 * 5. The registry holds no spinner glyph — loading is `KortixLoader` or `Skeleton`.
 */

type SourceFile = { path: string; source: string };

const MOBILE_ROOT = join(import.meta.dir, '..', '..');
const SOURCE_DIRS = ['app', 'components', 'lib', 'hooks', 'stores', 'contexts', 'api', 'types'];
const BANNED_PACKAGES = ['lucide-react-native', '@expo/vector-icons', 'react-native-vector-icons'];
const REGISTRY_PATH = 'lib/icons/index.ts';
const NON_ICON_EXPORTS = new Set(['AppIcon', 'AppIconProps', 'DEFAULT_ICON_WEIGHT']);
const SPINNER_GLYPHS = new Set(['CircleNotchIcon', 'SpinnerIcon', 'SpinnerGapIcon', 'SpinnerBallIcon']);

function importSpecifiers(source: string): string[] {
  const specs: string[] = [];
  const re = /(?:import|export)\s[^;]*?from\s*['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const m of source.matchAll(re)) specs.push(m[1] ?? m[2]);
  return specs;
}

function registryExports(source: string): string[] {
  return [...source.matchAll(/^export const (\w+) = withAppWeight\(/gm)].map((m) => m[1]);
}

function importedIconNames(source: string): string[] {
  const names: string[] = [];
  for (const m of source.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*['"]@\/lib\/icons['"]/g)) {
    for (const raw of m[1].split(',')) {
      const name = raw.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim();
      if (name && !NON_ICON_EXPORTS.has(name)) names.push(name);
    }
  }
  return names;
}

export function findIconViolations(files: SourceFile[]): string[] {
  const violations: string[] = [];
  const consumed = new Set<string>();
  let registry: SourceFile | undefined;

  for (const file of files) {
    if (file.path === REGISTRY_PATH) registry = file;
    for (const spec of importSpecifiers(file.source)) {
      const pkg = BANNED_PACKAGES.find((p) => spec === p || spec.startsWith(`${p}/`));
      if (pkg) violations.push(`${file.path}: imports retired icon library '${spec}'`);
      if ((spec === 'phosphor-react-native' || spec.startsWith('phosphor-react-native/')) && !file.path.startsWith('lib/icons/')) {
        violations.push(`${file.path}: imports '${spec}' outside lib/icons — import from '@/lib/icons'`);
      }
    }
    if (file.path !== REGISTRY_PATH) for (const name of importedIconNames(file.source)) consumed.add(name);

    // lib/icons/bind.tsx is the one place that applies DEFAULT_ICON_WEIGHT.
    if (file.path.startsWith('lib/icons/')) continue;
    for (const m of file.source.matchAll(/\bweight=(?:"([^"]*)"|'([^']*)'|\{([^}]*)\})/g)) {
      const literal = m[1] ?? m[2];
      const expression = m[3];
      const values = literal !== undefined ? [literal] : [...(expression ?? '').matchAll(/['"]([^'"]*)['"]/g)].map((v) => v[1]);
      if (values.some((v) => v !== 'fill') || (literal === undefined && values.length === 0)) {
        violations.push(`${file.path}: icon weight '${m[0]}' — only weight="fill" may be passed; the weight is DEFAULT_ICON_WEIGHT`);
      }
    }
  }

  if (!registry) {
    violations.push(`${REGISTRY_PATH}: registry not found`);
  } else {
    for (const name of registryExports(registry.source)) {
      if (SPINNER_GLYPHS.has(name)) violations.push(`${REGISTRY_PATH}: ${name} is a spinner glyph — use KortixLoader`);
      if (!consumed.has(name)) violations.push(`${REGISTRY_PATH}: ${name} has no consumer — remove it (unused icons still ship)`);
    }
  }
  return violations;
}

function readSourceTree(): SourceFile[] {
  const files: SourceFile[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules') continue;
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(tsx?|jsx?)$/.test(entry) && !entry.endsWith('.test.ts')) {
        files.push({ path: relative(MOBILE_ROOT, path), source: readFileSync(path, 'utf8') });
      }
    }
  };
  for (const dir of SOURCE_DIRS) {
    try {
      walk(join(MOBILE_ROOT, dir));
    } catch {
      // Optional directory absent.
    }
  }
  return files;
}

const REGISTRY_FIXTURE: SourceFile = {
  path: REGISTRY_PATH,
  source: "export const CheckIcon = withAppWeight(CheckGlyph, 'CheckIcon');\n",
};
const CONSUMER_FIXTURE: SourceFile = {
  path: 'components/ok.tsx',
  source: "import { CheckIcon as Check } from '@/lib/icons';\n<Check weight=\"fill\" />",
};

describe('icon import guard', () => {
  it('passes a clean fixture', () => {
    expect(findIconViolations([REGISTRY_FIXTURE, CONSUMER_FIXTURE])).toEqual([]);
  });

  it('reports each class of violation in a fixture', () => {
    const violations = findIconViolations([
      REGISTRY_FIXTURE,
      { path: 'components/a.tsx', source: "import { X } from 'lucide-react-native';" },
      { path: 'components/b.tsx', source: "import { Ionicons } from '@expo/vector-icons';" },
      { path: 'components/c.tsx', source: "import { GearIcon } from 'phosphor-react-native/src/icons/Gear';" },
      { path: 'components/d.tsx', source: '<Check weight="regular" />' },
      { path: 'components/e.tsx', source: "<Check weight={on ? 'bold' : 'fill'} />" },
      {
        path: REGISTRY_PATH,
        source: "export const CheckIcon = withAppWeight(CheckGlyph, 'CheckIcon');\nexport const CircleNotchIcon = withAppWeight(CircleNotchGlyph, 'CircleNotchIcon');\n",
      },
      { path: 'components/g.tsx', source: "import { CircleNotchIcon } from '@/lib/icons';" },
    ]);
    expect(violations).toEqual([
      "components/a.tsx: imports retired icon library 'lucide-react-native'",
      "components/b.tsx: imports retired icon library '@expo/vector-icons'",
      "components/c.tsx: imports 'phosphor-react-native/src/icons/Gear' outside lib/icons — import from '@/lib/icons'",
      `components/d.tsx: icon weight 'weight="regular"' — only weight="fill" may be passed; the weight is DEFAULT_ICON_WEIGHT`,
      "components/e.tsx: icon weight 'weight={on ? 'bold' : 'fill'}' — only weight=\"fill\" may be passed; the weight is DEFAULT_ICON_WEIGHT",
      'lib/icons/index.ts: CheckIcon has no consumer — remove it (unused icons still ship)',
      'lib/icons/index.ts: CircleNotchIcon is a spinner glyph — use KortixLoader',
    ]);
  });

  it('allows a conditional fill', () => {
    const source = "import { PlayIcon } from '@/lib/icons';\n<PlayIcon weight={on ? 'fill' : undefined} />";
    expect(findIconViolations([REGISTRY_FIXTURE, CONSUMER_FIXTURE, { path: 'components/f.tsx', source }])).toEqual([]);
  });

  it('the app source tree has no violations', () => {
    const files = readSourceTree();
    expect(files.some((f) => f.path === REGISTRY_PATH)).toBe(true);
    expect(files.length).toBeGreaterThan(300);
    expect(findIconViolations(files)).toEqual([]);
  });
});
