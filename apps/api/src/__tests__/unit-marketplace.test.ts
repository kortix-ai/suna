import { describe, expect, test } from 'bun:test';

// Keep the catalog hermetic — don't load the built-in default marketplaces
// (which would hit the network) unless a test explicitly opts in.
process.env.KORTIX_DEFAULT_MARKETPLACES = '';
import {
  DEFAULT_MARKETPLACES,
  assertAllowedSourceAddress,
  getCatalogItemDetail,
  githubLoaderOptions,
  listCatalogItems,
  listMarketplaces,
  marketplaceIdOf,
  registerMarketplaceSourceProvider,
  _resetExternalCache,
} from '../marketplace/catalog';
import { compareInstalled } from '@kortix/registry';
import { buildInstall, buildInstallBatch, resolveItemFiles } from '../marketplace/install-service';

describe('marketplace catalog', () => {
  test('default external sources are Anthropic only; Hermes stays opt-in', () => {
    expect(DEFAULT_MARKETPLACES).toEqual([
      'anthropics/skills',
      'anthropics/knowledge-work-plugins',
    ]);
    expect(DEFAULT_MARKETPLACES).not.toContain('NousResearch/hermes-agent');
  });

  test('lists the starter skill pack; non-skill items are hidden from browse', async () => {
    const all = await listCatalogItems();
    expect(all.length).toBeGreaterThan(50);

    // Launch scope: marketplace browsing is the skill library. Non-skill
    // registry entries remain internal for compatibility/dependency handling.
    expect(all.some((i) => i.type === 'registry:bundle')).toBe(false);
    expect(all.some((i) => i.type === 'registry:agent')).toBe(false);
    expect(all.some((i) => i.type === 'registry:tool')).toBe(false);
    expect(all.find((i) => i.id === 'kortix:research-pack')).toBeUndefined();

    expect(all.find((i) => i.name === 'pdf')).toBeTruthy();
  });

  test('lists only optional Kortix skills through the marketplace', async () => {
    const all = await listCatalogItems({ source: 'kortix' });
    const agentBrowser = all.find((i) => i.name === 'agent-browser');
    expect(agentBrowser).toBeTruthy();
    expect(agentBrowser!.marketplaceId).toBe('kortix');
    expect(agentBrowser!.type).toBe('registry:skill');
    expect(agentBrowser!.managedBy).toBeUndefined();
    expect(agentBrowser!.defaultProjectInstall).toBe(true);
    expect(all.find((i) => i.name === 'pty')).toBeUndefined();
    expect(all.find((i) => i.name === 'kortix-simple-memory')).toBeUndefined();
    expect(all.find((i) => i.name === 'web_search')).toBeUndefined();
    expect(all.find((i) => i.name === 'scrape_webpage')).toBeUndefined();
    expect(all.find((i) => i.name === 'image_search')).toBeUndefined();
    expect(all
      .filter((i) => i.defaultProjectInstall)
      .map((i) => i.name)
      .sort()).toEqual([
        'agent-browser',
        'deep-research',
        'document-review',
        'docx',
        'pdf',
        'presentations',
        'research-report',
        'website-building',
        'xlsx',
      ]);
    expect(all.find((i) => i.name === 'kortix-tool-env')).toBeUndefined();
  });

  test('marks only kortix-* runtime skills as Kortix-managed', async () => {
    const all = await listCatalogItems();
    const managed = all.filter((i) => i.managedBy === 'kortix').map((i) => i.name).sort();

    expect(managed).toEqual([
      'kortix-computer',
      'kortix-executor',
      'kortix-memory',
      'kortix-slack',
      'kortix-system',
    ]);
    expect(all.find((i) => i.name === 'agent-browser')?.managedBy).toBeUndefined();
    expect(all.find((i) => i.name === 'kortix')?.managedBy).toBeUndefined();
    expect(all.find((i) => i.name === 'memory-reflector')?.managedBy).toBeUndefined();
    expect(all.find((i) => i.name === 'web_search')?.managedBy).toBeUndefined();
    expect(all.find((i) => i.name === 'pdf')?.managedBy).toBeUndefined();
  });

  test('filters by type and query', async () => {
    expect((await listCatalogItems({ type: 'bundle' })).length).toBe(0); // bundles hidden
    expect((await listCatalogItems({ query: 'pdf' })).some((i) => i.name === 'pdf')).toBe(true);
    expect((await listCatalogItems({ query: 'zzzznotathing' })).length).toBe(0);
  });

  test('source safety — rejects local + private/non-https URLs (LFI/SSRF guard)', () => {
    // Allowed: github + public https.
    expect(() => assertAllowedSourceAddress('anthropics/skills')).not.toThrow();
    expect(() => assertAllowedSourceAddress('https://example.com/registry.json')).not.toThrow();
    // Rejected: local-folder reads (LFI).
    expect(() => assertAllowedSourceAddress('./local-folder')).toThrow();
    expect(() => assertAllowedSourceAddress('/etc')).toThrow();
    // Rejected: SSRF — cloud metadata, localhost, RFC-1918, non-https.
    expect(() => assertAllowedSourceAddress('http://169.254.169.254/latest/meta-data')).toThrow();
    expect(() => assertAllowedSourceAddress('http://localhost:8008/x')).toThrow();
    expect(() => assertAllowedSourceAddress('https://192.168.1.10/registry.json')).toThrow();
    expect(() => assertAllowedSourceAddress('http://example.com/registry.json')).toThrow();
  });

  test('browse by marketplace — listMarketplaces + source filter', async () => {
    const mkts = await listMarketplaces();
    const kortix = mkts.find((m) => m.id === 'kortix')!;
    expect(kortix).toBeTruthy();
    expect(kortix.label).toBe('Kortix');
    expect(kortix.external).toBe(false);
    expect(kortix.count).toBeGreaterThan(50);

    // The base registries (kortix bundles + kortix-starter skills) collapse to one id…
    expect(marketplaceIdOf('kortix-starter')).toBe('kortix');
    expect(marketplaceIdOf('anthropics/skills')).toBe('anthropics/skills');

    // …and the source filter narrows the catalog to exactly that marketplace.
    const kortixOnly = await listCatalogItems({ source: 'kortix' });
    expect(kortixOnly.length).toBe(kortix.count);
    expect(kortixOnly.every((i) => marketplaceIdOf(i.registry) === 'kortix')).toBe(true);
    expect(await listCatalogItems({ source: 'nope/nothing' })).toHaveLength(0);
  });

  test('surfaces capability hints (secrets / tools) on known skills', async () => {
    const all = await listCatalogItems();
    expect(all.find((i) => i.name === 'elevenlabs')?.capabilities.secrets).toContain('ELEVENLABS_API_KEY');
    expect(all.find((i) => i.name === 'replicate')?.capabilities.secrets).toContain('REPLICATE_API_TOKEN');
    expect(all.find((i) => i.name === 'deep-research')?.capabilities.tools).toContain('web_search');
    // A plain skill has no special permissions.
    expect(all.find((i) => i.name === 'pdf')?.capabilities.secrets.length).toBe(0);
  });

  test('item detail carries files + a readme', async () => {
    const pdf = (await listCatalogItems({ query: 'pdf' })).find((i) => i.name === 'pdf')!;
    const detail = (await getCatalogItemDetail(pdf.id))!;
    expect(detail.files.length).toBeGreaterThan(1);
    expect(detail.files.every((f) => f.target.startsWith('@skills/'))).toBe(true);
    expect(detail.readme).toContain('---');
  });

  test('buildInstall(skill) → expanded files + a valid v2 lock', async () => {
    const pdf = (await listCatalogItems({ query: 'pdf' })).find((i) => i.name === 'pdf')!;
    const built = await buildInstall({
      id: pdf.id,
      configDir: '.kortix/opencode',
      existingLockRaw: null,
      legacyLockRaw: null,
      now: '2026-06-16T00:00:00.000Z',
    });
    expect(built.files.some((f) => f.path === '.kortix/opencode/skills/pdf/SKILL.md')).toBe(true);
    expect(built.installed.map((i) => i.name)).toContain('pdf');
    const lock = JSON.parse(built.files.find((f) => f.path === 'registry-lock.json')!.content);
    expect(lock.version).toBe(2);
    expect(lock.items.pdf.type).toBe('registry:skill');
  });

  test('buildInstall(agent-browser) installs the default marketplace skill', async () => {
    const agentBrowser = (await listCatalogItems({ query: 'agent-browser', source: 'kortix' })).find((i) => i.name === 'agent-browser')!;
    const built = await buildInstall({
      id: agentBrowser.id,
      configDir: '.kortix/opencode',
      existingLockRaw: null,
      legacyLockRaw: null,
      now: '2026-06-16T00:00:00.000Z',
    });

    const paths = built.files.map((f) => f.path);
    expect(paths).toContain('.kortix/opencode/skills/agent-browser/SKILL.md');
    expect(built.installed.map((i) => i.name)).toEqual(['agent-browser']);
    expect(built.capabilities.tools).toContain('agent-browser');
  });

  test('buildInstall(bundle) → pulls every dependency in one commit', async () => {
    const built = await buildInstall({
      id: 'kortix:research-pack',
      configDir: '.kortix/opencode',
      existingLockRaw: null,
      legacyLockRaw: null,
      now: '2026-06-16T00:00:00.000Z',
    });
    const names = built.installed.map((i) => i.name);
    for (const dep of ['deep-research', 'research-report', 'openalex-paper-search']) {
      expect(names).toContain(dep);
    }
    expect(built.files.filter((f) => f.path.endsWith('/SKILL.md')).length).toBeGreaterThanOrEqual(3);
  });

  test('update detection — installed item compares up-to-date against its source', async () => {
    const pdf = (await listCatalogItems({ query: 'pdf' })).find((i) => i.name === 'pdf')!;
    const built = await buildInstall({
      id: pdf.id,
      configDir: '.kortix/opencode',
      existingLockRaw: null,
      legacyLockRaw: null,
      now: '2026-06-16T00:00:00.000Z',
    });
    const lock = JSON.parse(built.files.find((f) => f.path === 'registry-lock.json')!.content);
    const lockedPdf = lock.items.pdf.files as Array<{ target: string; hash: string }>;

    const fresh = await resolveItemFiles('pdf', '.kortix/opencode');
    expect(fresh).not.toBeNull();
    expect(compareInstalled(lockedPdf, fresh).status).toBe('up-to-date');

    // A tampered/older hash in the lock ⇒ update-available.
    const stale = lockedPdf.map((f, i) => (i === 0 ? { ...f, hash: 'deadbeef' } : f));
    expect(compareInstalled(stale, fresh).status).toBe('update-available');

    // An item that's no longer in the catalog ⇒ orphaned (null fresh files).
    expect(await resolveItemFiles('zzz-not-a-real-skill', '.kortix/opencode')).toBeNull();
  });

  test('buildInstall merges into an existing lock instead of clobbering it', async () => {
    const existing = JSON.stringify({
      version: 2,
      items: { 'prior-skill': { type: 'registry:skill', source: 'x', sourceType: 'local', files: [] } },
    });
    const pdf = (await listCatalogItems({ query: 'pdf' })).find((i) => i.name === 'pdf')!;
    const built = await buildInstall({
      id: pdf.id,
      configDir: '.kortix/opencode',
      existingLockRaw: existing,
      legacyLockRaw: null,
      now: '2026-06-16T00:00:00.000Z',
    });
    const lock = JSON.parse(built.files.find((f) => f.path === 'registry-lock.json')!.content);
    expect(lock.items['prior-skill']).toBeTruthy();
    expect(lock.items.pdf).toBeTruthy();
  });

  test('buildInstallBatch updates multiple items into one combined lock write', async () => {
    const catalog = await listCatalogItems({ source: 'kortix' });
    const pdf = catalog.find((i) => i.name === 'pdf')!;
    const docx = catalog.find((i) => i.name === 'docx')!;
    const built = await buildInstallBatch({
      ids: [pdf.id, docx.id],
      configDir: '.kortix/opencode',
      existingLockRaw: null,
      legacyLockRaw: null,
      now: '2026-06-16T00:00:00.000Z',
    });
    const lockWrites = built.files.filter((f) => f.path === 'registry-lock.json');
    expect(lockWrites).toHaveLength(1);
    const lock = JSON.parse(lockWrites[0]!.content);
    expect(lock.items.pdf.type).toBe('registry:skill');
    expect(lock.items.docx.type).toBe('registry:skill');
    expect(built.installed.map((i) => i.name).sort()).toEqual(['docx', 'pdf']);
  });
});

describe('marketplace external registries (skills.sh / GitHub path)', () => {
  const ORIG_FETCH = globalThis.fetch;
  const ORIG_GITHUB_FETCH = githubLoaderOptions.fetchImpl;
  const RAW = 'https://raw.githubusercontent.com/mockorg/mockrepo/main';

  function stub(map: Record<string, string>) {
    const fetchStub = (async (url: unknown) => {
      const key = typeof url === 'object' && url && 'url' in url ? String((url as Request).url) : String(url);
      const body = map[key];
      if (body == null) return new Response('not found', { status: 404 });
      return new Response(body, { status: 200 });
    }) as typeof fetch;
    globalThis.fetch = fetchStub;
    githubLoaderOptions.fetchImpl = fetchStub;
  }

  function restoreFetch() {
    globalThis.fetch = ORIG_FETCH;
    githubLoaderOptions.fetchImpl = ORIG_GITHUB_FETCH;
  }

  test.serial('ingests an external registry + installs its item from source', async () => {
    stub({
      [`${RAW}/registry.json`]: JSON.stringify({
        name: 'mock-skills',
        items: [
          {
            name: 'hello-ext',
            type: 'registry:skill',
            title: 'Hello (external)',
            files: [{ path: 'hello/SKILL.md', type: 'registry:file', target: '@skills/hello-ext/SKILL.md' }],
          },
        ],
      }),
      [`${RAW}/hello/SKILL.md`]: '---\nname: hello-ext\n---\n# Hi from an external registry',
    });
    process.env.KORTIX_MARKETPLACE_REGISTRIES = 'github:mockorg/mockrepo';
    _resetExternalCache();
    try {
      const all = await listCatalogItems();
      const ext = all.find((i) => i.name === 'hello-ext');
      expect(ext).toBeTruthy();
      expect(ext!.external).toBe(true);
      expect(ext!.id).toBe('mock-skills:hello-ext');
      expect(ext!.sourceUrl).toBe('https://github.com/mockorg/mockrepo');

      const built = await buildInstall({
        id: 'mock-skills:hello-ext',
        configDir: '.kortix/opencode',
        existingLockRaw: null,
        legacyLockRaw: null,
        now: '2026-06-16T00:00:00.000Z',
      });
      const skillFile = built.files.find((f) => f.path === '.kortix/opencode/skills/hello-ext/SKILL.md');
      expect(skillFile).toBeTruthy();
      expect(skillFile!.content).toContain('Hi from an external registry');
    } finally {
      restoreFetch();
      delete process.env.KORTIX_MARKETPLACE_REGISTRIES;
      _resetExternalCache();
    }
  });

  test.serial('a flaky external registry degrades gracefully (base still served)', async () => {
    stub({}); // every fetch 404s
    process.env.KORTIX_MARKETPLACE_REGISTRIES = 'github:does-not/exist';
    _resetExternalCache();
    try {
      const all = await listCatalogItems();
      expect(all.find((i) => i.name === 'pdf')).toBeTruthy(); // base intact
      expect(all.find((i) => i.name === 'hello-ext')).toBeUndefined();
    } finally {
      restoreFetch();
      delete process.env.KORTIX_MARKETPLACE_REGISTRIES;
      _resetExternalCache();
    }
  });

  test.serial('DB-persisted "Add marketplace" sources merge into the catalog', async () => {
    stub({
      [`${RAW}/registry.json`]: JSON.stringify({
        name: 'db-mock',
        items: [
          {
            name: 'db-ext',
            type: 'registry:skill',
            title: 'DB ext',
            files: [{ path: 'db/SKILL.md', type: 'registry:file', target: '@skills/db-ext/SKILL.md' }],
          },
        ],
      }),
      [`${RAW}/db/SKILL.md`]: '---\nname: db-ext\n---\n# from a stored source',
    });
    registerMarketplaceSourceProvider(async () => [
      { id: 's1', address: 'github:mockorg/mockrepo', addedAt: '2026-06-16T00:00:00.000Z' },
    ]);
    _resetExternalCache();
    try {
      const ext = (await listCatalogItems()).find((i) => i.name === 'db-ext');
      expect(ext).toBeTruthy();
      expect(ext!.external).toBe(true);
      expect(ext!.id).toBe('db-mock:db-ext');
    } finally {
      restoreFetch();
      registerMarketplaceSourceProvider(async () => []);
      _resetExternalCache();
    }
  });
});
