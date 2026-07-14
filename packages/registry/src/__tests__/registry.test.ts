import { describe, expect, test } from 'bun:test';
import { parseItemAddress, parseRegistryAddress, rawGithubUrl } from '../address';
import { validateRegistry } from '../validate';
import { expandTarget } from '../paths';
import { buildRegistry, type BuildSource } from '../build';
import { loadItem, loadRegistry } from '../fetch';

// --- address parsing -------------------------------------------------------

describe('parseItemAddress', () => {
  test('github owner/repo/item', () => {
    const a = parseItemAddress('kortix-ai/skills/pdf');
    expect(a.registry).toEqual({ kind: 'github', owner: 'kortix-ai', repo: 'skills', ref: undefined, subdir: undefined });
    expect(a.item).toBe('pdf');
  });

  test('github with scheme + pinned ref', () => {
    const a = parseItemAddress('github:kortix-ai/skills@v1/pdf');
    expect(a.registry).toMatchObject({ kind: 'github', owner: 'kortix-ai', repo: 'skills', ref: 'v1' });
    expect(a.item).toBe('pdf');
  });

  test('namespace', () => {
    const a = parseItemAddress('@kortix/pdf');
    expect(a.registry).toEqual({ kind: 'namespace', namespace: '@kortix' });
    expect(a.item).toBe('pdf');
  });

  test('local with #item', () => {
    const a = parseItemAddress('./r/registry.json#pdf');
    expect(a.registry).toEqual({ kind: 'local', path: './r/registry.json' });
    expect(a.item).toBe('pdf');
  });

  test('direct item URL', () => {
    const a = parseItemAddress('https://h.dev/r/pdf.json');
    expect(a.item).toBe('pdf');
    expect(a.directItemUrl).toBe('https://h.dev/r/pdf.json');
    expect(a.registry).toEqual({ kind: 'url', url: 'https://h.dev/r/registry.json' });
  });

  test('bare item name has no registry', () => {
    const a = parseItemAddress('pdf');
    expect(a.registry).toBeNull();
    expect(a.item).toBe('pdf');
  });

  test('a 2-segment github address is a registry, not an item', () => {
    expect(() => parseItemAddress('kortix-ai/skills')).toThrow();
  });
});

describe('parseRegistryAddress', () => {
  test('github + ref', () => {
    expect(parseRegistryAddress('owner/repo@main')).toMatchObject({ kind: 'github', owner: 'owner', repo: 'repo', ref: 'main' });
  });
  test('local dir', () => {
    expect(parseRegistryAddress('./reg')).toEqual({ kind: 'local', path: './reg' });
  });
  test('rawGithubUrl', () => {
    expect(rawGithubUrl('o', 'r', 'main', 'a/b.json')).toBe('https://raw.githubusercontent.com/o/r/main/a/b.json');
  });
});

// --- validation ------------------------------------------------------------

describe('validateRegistry', () => {
  test('accepts a well-formed registry', () => {
    const res = validateRegistry({
      name: 'acme',
      items: [{ name: 'pdf', type: 'registry:skill', files: [{ path: 'a', type: 'registry:file', target: '@skills/pdf/a' }] }],
    });
    expect(res.valid).toBe(true);
  });

  test('requires a name', () => {
    const res = validateRegistry({ items: [] });
    expect(res.valid).toBe(false);
    expect(res.issues.some((i) => i.path === 'name')).toBe(true);
  });

  test('rejects duplicate item names', () => {
    const res = validateRegistry({
      name: 'a',
      items: [
        { name: 'x', type: 'registry:file', files: [{ path: 'p', type: 'registry:file', target: '~/p' }] },
        { name: 'x', type: 'registry:file', files: [{ path: 'q', type: 'registry:file', target: '~/q' }] },
      ],
    });
    expect(res.valid).toBe(false);
    expect(res.issues.some((i) => i.message.includes('duplicate'))).toBe(true);
  });

  test('rejects a target that escapes the project', () => {
    const res = validateRegistry({
      name: 'a',
      items: [{ name: 'x', type: 'registry:file', files: [{ path: 'p', type: 'registry:file', target: '../evil' }] }],
    });
    expect(res.valid).toBe(false);
  });
});

// --- target expansion ------------------------------------------------------

describe('expandTarget', () => {
  const ctx = { configDir: '.kortix/opencode' };
  test('~ maps to repo root', () => {
    expect(expandTarget('~/AGENTS.md', ctx)).toBe('AGENTS.md');
  });
  test('@skills alias', () => {
    expect(expandTarget('@skills/pdf/SKILL.md', ctx)).toBe('.kortix/opencode/skills/pdf/SKILL.md');
  });
  test('@agents alias', () => {
    expect(expandTarget('@agents/researcher.md', ctx)).toBe('.kortix/opencode/agents/researcher.md');
  });
  test('@memory alias', () => {
    expect(expandTarget('@memory/MEMORY.md', ctx)).toBe('.kortix/memory/MEMORY.md');
  });
  test('respects a custom config dir', () => {
    expect(expandTarget('@skills/pdf/SKILL.md', { configDir: '.agent' })).toBe('.agent/skills/pdf/SKILL.md');
  });
  test('rejects path traversal', () => {
    expect(() => expandTarget('~/../escape', ctx)).toThrow();
  });
});

// --- build -----------------------------------------------------------------

function memSource(files: Record<string, string>): BuildSource {
  const paths = Object.keys(files);
  return {
    listFiles: () => paths,
    readFile: (p) => {
      if (!(p in files)) throw new Error(`no such file ${p}`);
      return files[p];
    },
    isDirectory: (p) => {
      const clean = p.replace(/\/+$/, '');
      return paths.some((f) => f.startsWith(`${clean}/`)) && !(p in files);
    },
  };
}

describe('buildRegistry', () => {
  test('detects skills (with nested files), agents, commands, tools', () => {
    const { registry, counts } = buildRegistry({
      name: 'test',
      source: memSource({
        '.kortix/opencode/skills/pdf/SKILL.md': '---\nname: pdf\ndescription: PDFs\n---\nbody',
        '.kortix/opencode/skills/pdf/libraries/reportlab.md': 'ref',
        '.kortix/opencode/skills/GROUP/research/SKILL.md': '---\nname: research\n---\nx',
        '.kortix/opencode/agents/kortix.md': '---\nname: kortix\nmode: primary\n---\n',
        '.kortix/opencode/commands/review.md': '---\ndescription: review\n---\n',
        '.kortix/opencode/tools/web_search.ts': 'export const x = 1',
      }),
    });
    expect(counts).toMatchObject({ skill: 2, agent: 1, command: 1, tool: 1 });

    const pdf = registry.items!.find((i) => i.name === 'pdf')!;
    expect(pdf.type).toBe('registry:skill');
    expect(pdf.files!.map((f) => f.target).sort()).toEqual([
      '@skills/pdf/SKILL.md',
      '@skills/pdf/libraries/reportlab.md',
    ]);

    // A grouped skill flattens to its leaf name on install.
    const research = registry.items!.find((i) => i.name === 'research')!;
    expect(research.files![0].target).toBe('@skills/research/SKILL.md');
  });

  test('expands an author-declared folder into per-file entries', () => {
    const { registry } = buildRegistry({
      name: 'test',
      source: memSource({
        'kortix.registry.json': JSON.stringify({
          items: [{ name: 'docs', type: 'registry:file', files: [{ path: 'docs', type: 'registry:file', target: '~/docs' }] }],
        }),
        'docs/a.md': 'a',
        'docs/sub/b.md': 'b',
      }),
    });
    const docs = registry.items!.find((i) => i.name === 'docs')!;
    expect(docs.files!.map((f) => f.target).sort()).toEqual(['~/docs/a.md', '~/docs/sub/b.md']);
  });
});

// --- fetch (local registry, injected reader) -------------------------------

describe('loadRegistry / loadItem (local + include)', () => {
  const tree: Record<string, string> = {
    '/reg/registry.json': JSON.stringify({ name: 'r', include: ['skills/registry.json'] }),
    '/reg/skills/registry.json': JSON.stringify({
      items: [{ name: 'pdf', type: 'registry:skill', files: [{ path: 'pdf/SKILL.md', type: 'registry:file', target: '@skills/pdf/SKILL.md' }] }],
    }),
    '/reg/skills/pdf/SKILL.md': 'PDF BODY',
  };
  const opts = { readFile: async (p: string) => {
    if (!(p in tree)) throw new Error(`missing ${p}`);
    return tree[p];
  } };

  test('include composition flattens items and resolves file base', async () => {
    const resolved = await loadRegistry({ kind: 'local', path: '/reg/registry.json' }, opts);
    expect(resolved.registry.items!.map((i) => i.name)).toEqual(['pdf']);
    // file path "pdf/SKILL.md" is declared in skills/registry.json → base "skills"
    expect(await resolved.readItemFile('pdf', 'pdf/SKILL.md')).toBe('PDF BODY');
  });

  test('loadItem resolves the file content', async () => {
    const item = await loadItem(parseItemAddress('/reg/registry.json#pdf'), opts);
    expect(item.item.name).toBe('pdf');
    expect(await item.readFile('pdf/SKILL.md')).toBe('PDF BODY');
  });

  test('inline content wins over fetching', async () => {
    const tree2 = {
      '/r2/registry.json': JSON.stringify({
        name: 'r2',
        items: [{ name: 'note', type: 'registry:file', files: [{ path: 'note.md', type: 'registry:file', target: '~/note.md', content: 'INLINE' }] }],
      }),
    };
    const item = await loadItem(parseItemAddress('/r2/registry.json#note'), {
      readFile: async (p: string) => (tree2 as Record<string, string>)[p] ?? (() => { throw new Error('x'); })(),
    });
    expect(await item.readFile('note.md')).toBe('INLINE');
  });
});

// --- SKILL.md scan fallback (Anthropic / skills.sh / Codex compatibility) ---

describe('loadRegistry — SKILL.md scan fallback (no registry.json)', () => {
  function stub(map: Record<string, string>): typeof fetch {
    return (async (url: unknown) => {
      const body = map[String(url)];
      if (body == null) return new Response('not found', { status: 404 });
      return new Response(body, { status: 200 });
    }) as typeof fetch;
  }

  test('synthesizes registry:skill items by scanning a registry-less repo', async () => {
    const fetchImpl = stub({
      // no registry.json on either ref → forces the scan fallback
      'https://api.github.com/repos/acme/skills/git/trees/main?recursive=1': JSON.stringify({
        tree: [
          { path: 'skills/pdf/SKILL.md', type: 'blob' },
          { path: 'skills/pdf/reference.md', type: 'blob' },
          { path: 'README.md', type: 'blob' },
        ],
      }),
      'https://raw.githubusercontent.com/acme/skills/main/skills/pdf/SKILL.md':
        '---\nname: pdf\ndescription: Work with PDFs\n---\n# PDF skill',
    });

    const resolved = await loadRegistry({ kind: 'github', owner: 'acme', repo: 'skills' }, { fetchImpl });
    const pdf = resolved.registry.items!.find((i) => i.name === 'pdf')!;
    expect(pdf.type).toBe('registry:skill');
    expect(pdf.description).toBe('Work with PDFs');
    // SKILL.md + its sibling reference file, targeted under @skills/<name>/
    expect(pdf.files!.map((f) => f.target).sort()).toEqual([
      '@skills/pdf/SKILL.md',
      '@skills/pdf/reference.md',
    ]);
    expect(await resolved.readItemFile('pdf', 'skills/pdf/SKILL.md')).toContain('# PDF skill');
  });

  test('honors a sparse subpath (Codex-style)', async () => {
    const fetchImpl = stub({
      'https://api.github.com/repos/org/mono/git/trees/main?recursive=1': JSON.stringify({
        tree: [
          { path: 'other/x/SKILL.md', type: 'blob' },
          { path: 'plugins/codex/hello/SKILL.md', type: 'blob' },
        ],
      }),
      'https://raw.githubusercontent.com/org/mono/main/plugins/codex/hello/SKILL.md':
        '---\nname: hello\n---\nhi',
    });
    const resolved = await loadRegistry(
      { kind: 'github', owner: 'org', repo: 'mono', subdir: 'plugins/codex' },
      { fetchImpl },
    );
    const names = resolved.registry.items!.map((i) => i.name);
    expect(names).toContain('hello');
    expect(names).not.toContain('x'); // outside the sparse path
  });

  test('layers registry:bundle from a Claude-Code/Codex marketplace.json', async () => {
    const fetchImpl = stub({
      'https://api.github.com/repos/acme/skills/git/trees/main?recursive=1': JSON.stringify({
        tree: [
          { path: 'skills/xlsx/SKILL.md', type: 'blob' },
          { path: 'skills/docx/SKILL.md', type: 'blob' },
          { path: '.claude-plugin/marketplace.json', type: 'blob' },
        ],
      }),
      'https://raw.githubusercontent.com/acme/skills/main/skills/xlsx/SKILL.md': '---\nname: xlsx\n---\nx',
      'https://raw.githubusercontent.com/acme/skills/main/skills/docx/SKILL.md': '---\nname: docx\n---\nd',
      'https://raw.githubusercontent.com/acme/skills/main/.claude-plugin/marketplace.json': JSON.stringify({
        name: 'office',
        plugins: [{ name: 'document-skills', description: 'Office files', skills: ['xlsx', 'document-skills/docx'] }],
      }),
    });
    const resolved = await loadRegistry(
      { kind: 'github', owner: 'acme', repo: 'skills' },
      { fetchImpl, includeBundles: true },
    );
    const names = resolved.registry.items!.map((i) => i.name);
    expect(names).toContain('xlsx');
    expect(names).toContain('docx');
    const bundle = resolved.registry.items!.find((i) => i.name === 'document-skills')!;
    expect(bundle.type).toBe('registry:bundle');
    expect(bundle.registryDependencies).toEqual(['xlsx', 'docx']); // leaf names, only the scanned ones
  });
});
