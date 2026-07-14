import { describe, expect, test } from 'bun:test';

// Keep the catalog hermetic — don't load the built-in default marketplaces
// (which would hit the network) unless a test explicitly opts in.
process.env.KORTIX_DEFAULT_MARKETPLACES = '';
import {
  DEFAULT_MARKETPLACES,
  assertAllowedSourceAddress,
  findCatalogEntryByName,
  getCatalogItemDetail,
  getCatalogItemFile,
  githubLoaderOptions,
  listCatalogItems,
  listMarketplaces,
  marketplaceIdOf,
  registerMarketplaceSourceProvider,
  _resetExternalCache,
} from '../marketplace/catalog';

describe('marketplace catalog', () => {
  test('no external marketplaces are enabled by default — Anthropic and Hermes both stay opt-in', () => {
    // Only Kortix loads out of the box; every external source (Anthropic
    // included) is a one-click "Add a source" from FEATURED_MARKETPLACES.
    expect(DEFAULT_MARKETPLACES).toEqual([]);
    expect(DEFAULT_MARKETPLACES).not.toContain('NousResearch/hermes-agent');
    expect(DEFAULT_MARKETPLACES).not.toContain('anthropics/skills');
  });

  test('surfaces the starter project and its skills through browse; support types stay internal', async () => {
    const all = await listCatalogItems();

    // The marketplace leads with the "Kortix Starter" project as the hero, but
    // individual kortix-starter skills are ALSO browseable top-level tiles
    // (each one also ships inside the project). Support types (bundles/tools/
    // files) stay internal for dependency handling.
    expect(all.some((i) => i.type === 'registry:bundle')).toBe(false);
    expect(all.some((i) => i.type === 'registry:project')).toBe(true);
    expect(all.some((i) => i.type === 'registry:tool')).toBe(false);
    expect(all.some((i) => i.type === 'registry:file')).toBe(false);
    expect(all.find((i) => i.id === 'kortix-projects:starter')).toBeTruthy();

    // Browseable: a starter skill like `pdf` is a top-level browse tile again…
    const pdf = all.find((i) => i.name === 'pdf');
    expect(pdf).toBeTruthy();
    expect(pdf!.partOfProject).toEqual({ id: 'kortix-projects:starter', title: 'Kortix Starter' });

    // …and it's still resolvable by id and shows up typed inside the starter
    // project's "what's inside" list.
    const starterDetail = await getCatalogItemDetail('kortix-projects:starter');
    expect(starterDetail).toBeTruthy();
    expect(starterDetail!.dependencyItems.some((d) => d.name === 'pdf')).toBe(true);
  });

  test('lists optional Kortix skills through the marketplace', async () => {
    // agent-browser is browseable alongside every other kortix-starter skill,
    // and it stays fully resolvable by id and shows up inside the starter
    // project's dependencyItems.
    const all = await listCatalogItems({ source: 'kortix' });
    expect(all.find((i) => i.name === 'agent-browser')).toBeTruthy();

    const agentBrowser = await findCatalogEntryByName('agent-browser');
    expect(agentBrowser).toBeTruthy();
    expect(agentBrowser!.item.type).toBe('registry:skill');
    expect(agentBrowser!.item.meta?.managedBy).toBeUndefined();

    const agentBrowserDetail = await getCatalogItemDetail('kortix-starter:agent-browser');
    expect(agentBrowserDetail).toBeTruthy();
    expect(agentBrowserDetail!.marketplaceId).toBe('kortix');
    expect(agentBrowserDetail!.type).toBe('registry:skill');
    expect(agentBrowserDetail!.managedBy).toBeUndefined();
    expect(agentBrowserDetail!.defaultProjectInstall).toBe(true);

    const starterDetail = await getCatalogItemDetail('kortix-projects:starter');
    expect(starterDetail!.dependencyItems.some((d) => d.name === 'agent-browser')).toBe(true);

    // Support types / internal-only names never surface, by name or by browse.
    expect(await findCatalogEntryByName('pty')).toBeNull();
    expect(await findCatalogEntryByName('kortix-simple-memory')).toBeNull();
    expect((await findCatalogEntryByName('web_search'))?.item.type).toBe('registry:tool');
    expect((await findCatalogEntryByName('scrape_webpage'))?.item.type).toBe('registry:tool');
    expect((await findCatalogEntryByName('image_search'))?.item.type).toBe('registry:tool');
    expect(all.find((i) => i.name === 'pty')).toBeUndefined();
    expect(all.find((i) => i.name === 'kortix-simple-memory')).toBeUndefined();
    expect(all.find((i) => i.name === 'web_search')).toBeUndefined();
    expect(all.find((i) => i.name === 'scrape_webpage')).toBeUndefined();
    expect(all.find((i) => i.name === 'image_search')).toBeUndefined();
    expect(await findCatalogEntryByName('kortix-tool-env')).toBeNull();

    // The known default-install skills are still marked as such (resolved both
    // from the browse list directly and from the starter project's dependencyItems).
    const starterDepIds = starterDetail!.dependencyItems.map((d) => d.id);
    const depDetails = await Promise.all(starterDepIds.map((id) => getCatalogItemDetail(id)));
    const defaultInstallNames = new Set(
      depDetails.filter((d) => d?.defaultProjectInstall).map((d) => d!.name),
    );
    for (const name of [
      'agent-browser',
      'deep-research',
      'document-review',
      'docx',
      'pdf',
      'presentations',
      'research-report',
      'website-building',
      'xlsx',
    ]) {
      expect(defaultInstallNames.has(name)).toBe(true);
      expect(all.find((i) => i.name === name)?.defaultProjectInstall).toBe(true);
    }
  });

  test('marks only kortix-* runtime skills as Kortix-managed', async () => {
    // Managed system skills are excluded from the starter project's
    // dependencyItems (they're server-injected platform floor, not a project's
    // "what's inside" list) and from browse/detail (not browseable) — so managed
    // status is checked by name lookup instead. Non-managed starter skills are
    // browseable again, so their managed status can also be checked directly
    // off the browse list.
    const managedCandidates = [
      'kortix-computer',
      'kortix-executor',
      'kortix-marketplace',
      'kortix-meet',
      'kortix-memory',
      'kortix-onboarding',
      'kortix-slack',
      'kortix-system',
    ];
    for (const name of managedCandidates) {
      const entry = await findCatalogEntryByName(name);
      expect(entry?.item.meta?.managedBy).toBe('kortix');
    }
    for (const name of ['agent-browser', 'kortix', 'memory-reflector', 'web_search', 'pdf']) {
      const entry = await findCatalogEntryByName(name);
      expect(entry?.item.meta?.managedBy).toBeUndefined();
    }

    const all = await listCatalogItems();
    for (const name of managedCandidates) {
      expect(all.find((i) => i.name === name)).toBeUndefined();
    }
    for (const name of ['agent-browser', 'pdf']) {
      expect(all.find((i) => i.name === name)?.managedBy).toBeUndefined();
    }
  });

  test('filters by type and query', async () => {
    const projects = await listCatalogItems({ type: 'project' });
    expect(projects.length).toBeGreaterThan(0); // whole projects are browseable one-click clones
    expect(projects.every((i) => i.type === 'registry:project')).toBe(true);
    // `pdf` is browseable again — a query hit on its own tile.
    expect((await listCatalogItems({ query: 'pdf' })).some((i) => i.name === 'pdf')).toBe(true);
    expect((await listCatalogItems({ query: 'starter' })).some((i) => i.id === 'kortix-projects:starter')).toBe(true);
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
    // Kortix browses as the "Kortix Starter" project PLUS every individual
    // kortix-starter skill as its own top-level browse tile — so the facet
    // count is back to the full browseable kortix set, not the folded model's
    // single hero tile (1).
    expect(kortix.count).toBeGreaterThan(20);

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
    // Skills are browseable again — fetch them straight from the browse list.
    const all = await listCatalogItems({ source: 'kortix' });
    const deepResearch = all.find((i) => i.name === 'deep-research');
    expect(deepResearch?.capabilities.tools).toContain('web_search');
    const domainResearch = all.find((i) => i.name === 'domain-research');
    expect(domainResearch?.capabilities.network).toContain('rdap.org');
    // A plain skill has no special permissions.
    const pdf = all.find((i) => i.name === 'pdf');
    expect(pdf?.capabilities.secrets.length).toBe(0);
  });

  test('item detail carries files + a readme', async () => {
    const all = await listCatalogItems({ source: 'kortix' });
    const pdf = all.find((i) => i.name === 'pdf')!;
    expect(pdf.partOfProject?.title).toBe('Kortix Starter');
    const detail = (await getCatalogItemDetail(pdf.id))!;
    expect(detail.files.length).toBeGreaterThan(1);
    expect(detail.files.every((f) => f.target.startsWith('@skills/'))).toBe(true);
    expect(detail.readme).toContain('---');
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

  test.serial('ingests an external registry + surfaces its item through discovery', async () => {
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

      const detail = await getCatalogItemDetail('mock-skills:hello-ext');
      expect(detail).toBeTruthy();
      const skillFile = detail!.files.find((f) => f.target === '@skills/hello-ext/SKILL.md');
      expect(skillFile).toBeTruthy();

      const fetched = await getCatalogItemFile('mock-skills:hello-ext', '@skills/hello-ext/SKILL.md');
      expect(fetched?.content).toContain('Hi from an external registry');
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
      // Base intact — the starter project (browse now folds individual
      // kortix-starter skills like `pdf` inside it, so check by id/detail).
      expect(all.find((i) => i.id === 'kortix-projects:starter')).toBeTruthy();
      expect((await getCatalogItemDetail('kortix-starter:pdf'))).toBeTruthy();
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
