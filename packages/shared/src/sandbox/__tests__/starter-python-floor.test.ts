import { describe, expect, test } from 'bun:test';
/**
 * Drift gate between the baked Python package floor and the starter templates.
 *
 * The sandbox image pre-installs `pythonPackages` (runtime-versions.json) into
 * the managed interpreter, and the starter skills invoke their scripts with
 * bare `python3` on the strength of that floor. Nothing else ties the two
 * together: a skill that grows a new third-party import, or a floor package
 * that gets dropped, fails only at runtime inside a live sandbox — after a
 * ~9-minute bake. This test fails the same drift at unit-test time instead.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { PYTHON_PACKAGE_FLOOR, PYTHON_PACKAGE_FLOOR_IMPORTS } from '../../runtime-versions';

const TEMPLATES_DIR = resolve(import.meta.dir, '../../../../starter/templates');

const STDLIB = new Set([
  '__future__',
  'abc',
  'argparse',
  'asyncio',
  'base64',
  'binascii',
  'bisect',
  'calendar',
  'collections',
  'concurrent',
  'contextlib',
  'copy',
  'csv',
  'ctypes',
  'dataclasses',
  'datetime',
  'decimal',
  'difflib',
  'email',
  'enum',
  'errno',
  'fnmatch',
  'fractions',
  'functools',
  'getpass',
  'glob',
  'gzip',
  'hashlib',
  'heapq',
  'hmac',
  'html',
  'http',
  'importlib',
  'inspect',
  'io',
  'itertools',
  'json',
  'logging',
  'math',
  'mimetypes',
  'multiprocessing',
  'numbers',
  'operator',
  'os',
  'pathlib',
  'pickle',
  'platform',
  'pprint',
  'queue',
  'random',
  're',
  'secrets',
  'select',
  'shlex',
  'shutil',
  'signal',
  'socket',
  'sqlite3',
  'statistics',
  'string',
  'struct',
  'subprocess',
  'sys',
  'tarfile',
  'tempfile',
  'textwrap',
  'threading',
  'time',
  'tomllib',
  'traceback',
  'types',
  'typing',
  'unicodedata',
  'unittest',
  'urllib',
  'uuid',
  'warnings',
  'weakref',
  'xml',
  'zipfile',
  'zlib',
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

/**
 * Reference modules the starter ships for users to COPY INTO THEIR OWN app
 * (see shared/20-llm-api.md: "Copy into your project and call it from FastAPI
 * handlers"). They never run on the sandbox's bare python3, so their
 * dependencies belong to the user's project, not the baked floor. Extending
 * this map is a deliberate act — anything not listed must be floor-covered.
 */
const PROJECT_CODE_EXEMPTIONS: Record<string, Set<string>> = {
  'general-knowledge-worker/.kortix/opencode/skills/website-building/shared/llm-api': new Set([
    'openai',
    'elevenlabs',
  ]),
};

const allFiles = walk(TEMPLATES_DIR);
const pyFiles = allFiles.filter((f) => f.endsWith('.py'));
const textFiles = allFiles.filter((f) => /\.(md|py|ts)$/.test(f));

function topLevelModule(line: string): string | null {
  const match = /^\s*(?:import|from)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(line);
  return match ? match[1] : null;
}

function isLocalModule(file: string, mod: string): boolean {
  const dir = dirname(file);
  return existsSync(join(dir, `${mod}.py`)) || existsSync(join(dir, mod));
}

describe('starter templates stay in accordance with the baked Python floor', () => {
  const floorImports = new Set(Object.values(PYTHON_PACKAGE_FLOOR_IMPORTS));

  test('templates exist where this gate expects them', () => {
    expect(pyFiles.length).toBeGreaterThan(10);
  });

  const collectViolations = (file: string, source: string, violations: string[]) => {
    for (const line of source.split('\n')) {
      const mod = topLevelModule(line);
      if (!mod || STDLIB.has(mod) || floorImports.has(mod)) continue;
      if (isLocalModule(file, mod)) continue;
      const relative = file.slice(TEMPLATES_DIR.length + 1);
      const exemption = Object.entries(PROJECT_CODE_EXEMPTIONS).find(([prefix]) =>
        relative.startsWith(`${prefix}/`),
      );
      if (exemption?.[1].has(mod)) continue;
      violations.push(`${relative}: ${mod}`);
    }
  };

  test('every third-party import in starter Python scripts is baked into the floor', () => {
    const violations: string[] = [];
    for (const file of pyFiles) {
      collectViolations(file, readFileSync(file, 'utf-8'), violations);
    }
    expect(violations).toEqual([]);
  });

  test('every third-party import taught in doc Python code blocks is baked into the floor', () => {
    const violations: string[] = [];
    for (const file of textFiles.filter((f) => !f.endsWith('.py'))) {
      const text = readFileSync(file, 'utf-8');
      for (const block of text.matchAll(/```(?:python|py)\n([\s\S]*?)```/g)) {
        collectViolations(file, block[1], violations);
      }
    }
    expect(violations).toEqual([]);
  });

  const basePackageName = (spec: string): string =>
    /^["']?([A-Za-z0-9._-]+)/.exec(spec)?.[1]?.toLowerCase() ?? '';

  test('no floor package is still invoked through uv run --with', () => {
    const floorNames = new Set(Object.keys(PYTHON_PACKAGE_FLOOR).map(basePackageName));
    const violations: string[] = [];
    for (const file of textFiles) {
      const lines = readFileSync(file, 'utf-8').split('\n');
      for (const [index, line] of lines.entries()) {
        for (const match of line.matchAll(/--with[= ]('[^']+'|"[^"]+"|[^\s`]+)/g)) {
          for (const raw of match[1].split(',')) {
            const pkg = basePackageName(raw);
            if (floorNames.has(pkg)) {
              violations.push(`${file.slice(TEMPLATES_DIR.length + 1)}:${index + 1}: ${pkg}`);
            }
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
