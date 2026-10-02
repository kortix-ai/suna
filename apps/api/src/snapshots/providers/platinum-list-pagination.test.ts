import { afterEach, describe, expect, test } from 'bun:test';

const {
  findTemplateByName: findTemplateByNameWithDefaults,
  PlatinumAdapter,
  PlatinumTemplateListingError,
} = await import('./platinum');
const { SnapshotInUseError } = await import('./errors');

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const testClient = {
  isConfigured: () => true,
  async json<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await globalThis.fetch(`https://platinum.test${path}`, init);
    const text = await response.text();
    if (!response.ok) {
      throw new Error(
        `platinum ${init.method ?? 'GET'} ${path} -> ${response.status} ${text.slice(0, 300)}`,
      );
    }
    return (text ? JSON.parse(text) : {}) as T;
  },
};

const platinumProvider = new PlatinumAdapter(testClient);
const findTemplateByName = (name: string) =>
  findTemplateByNameWithDefaults(name, testClient);

/** Parse `?offset=` off a /v1/templates request URL (default 0). */
function offsetOf(input: RequestInfo | URL): number {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
  return Number(new URL(url, 'https://platinum.test').searchParams.get('offset') ?? '0');
}

function tpl(name: string): { id: string; name: string; state: string } {
  return { id: `id-${name}`, name, state: 'ready' };
}

function namedTpl(id: string, name: string): { id: string; name: string; state: string } {
  return { id, name, state: 'ready' };
}

describe('FIX-C — findTemplateByName paginates the /v1/templates list', () => {
  test('finds a template on page 2 (never a false-absent past the first 50)', async () => {
    // Page 0 = 50 filler templates (created_at DESC), page 1 = the sought one.
    const page0 = Array.from({ length: 50 }, (_, i) => tpl(`filler-${i}`));
    const page1 = [tpl('kortix-ppwarm-OLD')];
    let calls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls += 1;
      return jsonResponse(offsetOf(input) === 0 ? page0 : page1);
    }) as unknown as typeof fetch;

    const found = await findTemplateByName('kortix-ppwarm-OLD');
    expect(found?.id).toBe('id-kortix-ppwarm-OLD');
    expect(calls).toBe(2); // walked past the first full page
  });

  test('early-exits once the name is found (no needless extra page fetches)', async () => {
    const page0 = [tpl('kortix-ppwarm-NEW'), ...Array.from({ length: 49 }, (_, i) => tpl(`f-${i}`))];
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return jsonResponse(page0);
    }) as unknown as typeof fetch;

    const found = await findTemplateByName('kortix-ppwarm-NEW');
    expect(found?.id).toBe('id-kortix-ppwarm-NEW');
    expect(calls).toBe(1); // found on page 0 → stop, do not fetch page 1
  });

  test('a genuinely absent name returns null after exhausting the list (short last page)', async () => {
    const page0 = Array.from({ length: 50 }, (_, i) => tpl(`filler-${i}`));
    const page1 = Array.from({ length: 10 }, (_, i) => tpl(`filler-b-${i}`)); // < 50 → last page
    globalThis.fetch = (async (input: RequestInfo | URL) =>
      jsonResponse(offsetOf(input) === 0 ? page0 : page1)) as unknown as typeof fetch;

    await expect(findTemplateByName('kortix-ppwarm-NOPE')).resolves.toBeNull();
  });

  test('a page-fetch error surfaces as a listing FAILURE — never a false absent', async () => {
    globalThis.fetch = (async () => jsonResponse('bad gateway', 502)) as unknown as typeof fetch;
    await expect(findTemplateByName('kortix-ppwarm-x')).rejects.toBeInstanceOf(PlatinumTemplateListingError);
  });

  test('a mid-scan page error (page 1 fails after page 0 succeeded) still throws, never truncates to absent', async () => {
    const page0 = Array.from({ length: 50 }, (_, i) => tpl(`filler-${i}`));
    globalThis.fetch = (async (input: RequestInfo | URL) =>
      offsetOf(input) === 0 ? jsonResponse(page0) : jsonResponse('boom', 500)) as unknown as typeof fetch;

    await expect(findTemplateByName('kortix-ppwarm-past-page-0')).rejects.toBeInstanceOf(PlatinumTemplateListingError);
  });

  test('an offset-ignoring server (same page repeated) does NOT spin — stops on the no-new-ids guard', async () => {
    const samePage = Array.from({ length: 50 }, (_, i) => tpl(`filler-${i}`));
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return jsonResponse(samePage); // ignores offset: always the same 50
    }) as unknown as typeof fetch;

    await expect(findTemplateByName('kortix-ppwarm-not-here')).resolves.toBeNull();
    expect(calls).toBe(2); // page 0, then page 1 (all-duplicate ids) → stop
  });

  test('a full list past the hard page cap throws (never a silent truncation → absent)', async () => {
    let n = 0;
    globalThis.fetch = (async () =>
      // Always a full page of BRAND-NEW ids → advances forever until the cap.
      jsonResponse(Array.from({ length: 50 }, () => tpl(`u-${n++}`)))) as unknown as typeof fetch;

    await expect(findTemplateByName('kortix-ppwarm-deep')).rejects.toBeInstanceOf(PlatinumTemplateListingError);
  });
});

describe('FIX-C — getSnapshotState treats a failed listing as indeterminate, never "missing"', () => {
  test('a 5xx listing failure degrades to "unknown" (NOT "missing" → no needless rebuild)', async () => {
    globalThis.fetch = (async () => jsonResponse('unavailable', 503)) as unknown as typeof fetch;
    await expect(platinumProvider.getSnapshotState('kortix-ppwarm-x')).resolves.toBe('unknown');
  });

  test('a genuinely absent template (exhausted list) is "missing"', async () => {
    globalThis.fetch = (async () =>
      jsonResponse(Array.from({ length: 3 }, (_, i) => tpl(`other-${i}`)))) as unknown as typeof fetch;
    await expect(platinumProvider.getSnapshotState('kortix-ppwarm-x')).resolves.toBe('missing');
  });

  test('a 403 listing failure still PROPAGATES (auth is never degraded to a state)', async () => {
    globalThis.fetch = (async () => jsonResponse({ error: 'forbidden' }, 403)) as unknown as typeof fetch;
    await expect(platinumProvider.getSnapshotState('kortix-ppwarm-x')).rejects.toThrow(/403/);
  });
});

describe('FIX-C — listSnapshots returns the FULL paginated set', () => {
  test('spans multiple pages (reaper sees superseded tips past page 1)', async () => {
    const page0 = Array.from({ length: 50 }, (_, i) => tpl(`kortix-ppwarm-${i}`));
    const page1 = [tpl('kortix-ppwarm-old-a'), tpl('kortix-ppwarm-old-b')];
    globalThis.fetch = (async (input: RequestInfo | URL) =>
      jsonResponse(offsetOf(input) === 0 ? page0 : page1)) as unknown as typeof fetch;

    const names = (await platinumProvider.listSnapshots()).map((s) => s.name);
    expect(names).toHaveLength(52);
    expect(names).toContain('kortix-ppwarm-old-a');
    expect(names).toContain('kortix-ppwarm-old-b');
  });
});

describe('findFirstActiveSnapshot', () => {
  test('stops after page one when the highest-priority candidate is active', async () => {
    const scoped = 'kpp2-scoped';
    const page0 = [tpl(scoped), ...Array.from({ length: 49 }, (_, i) => tpl(`filler-${i}`))];
    const requests: number[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requests.push(offsetOf(input));
      return jsonResponse(page0);
    }) as unknown as typeof fetch;

    await expect(
      platinumProvider.findFirstActiveSnapshot([scoped, 'unscoped', 'legacy']),
    ).resolves.toBe(scoped);
    expect(requests).toEqual([0]);
  });

  test('selects the highest-priority active candidate after one complete pagination pass', async () => {
    const scoped = 'kortix-ppwarm-scoped';
    const unscoped = 'kortix-ppwarm-unscoped';
    const legacy = 'kortix-ppwarm-legacy';
    const page0 = [tpl(unscoped), ...Array.from({ length: 49 }, (_, i) => tpl(`filler-${i}`))];
    const page1 = [tpl(scoped), tpl(legacy)];
    const requests: number[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const offset = offsetOf(input);
      requests.push(offset);
      return jsonResponse(offset === 0 ? page0 : page1);
    }) as unknown as typeof fetch;

    await expect(
      platinumProvider.findFirstActiveSnapshot([scoped, unscoped, legacy]),
    ).resolves.toBe(scoped);
    expect(requests).toEqual([0, 50]);
  });

  test('checks every candidate with one listing pass when only the lowest-priority name exists', async () => {
    const scoped = 'kortix-ppwarm-scoped';
    const unscoped = 'kortix-ppwarm-unscoped';
    const legacy = 'kortix-ppwarm-legacy';
    const page0 = Array.from({ length: 50 }, (_, i) => tpl(`filler-${i}`));
    const page1 = [tpl(legacy)];
    const requests: number[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const offset = offsetOf(input);
      requests.push(offset);
      return jsonResponse(offset === 0 ? page0 : page1);
    }) as unknown as typeof fetch;

    await expect(
      platinumProvider.findFirstActiveSnapshot([scoped, unscoped, legacy]),
    ).resolves.toBe(legacy);
    expect(requests).toEqual([0, 50]);
  });
});

describe('deleteSnapshot removes every exact-name Platinum template', () => {
  test('deletes exact-name duplicates across every page', async () => {
    const target = 'kortix-ppwarm-project';
    const page0 = [
      namedTpl('duplicate-new', target),
      ...Array.from({ length: 49 }, (_, i) => tpl(`filler-${i}`)),
    ];
    const page1 = [namedTpl('duplicate-old', target), tpl('unrelated')];
    const offsets: number[] = [];
    const deleted: string[] = [];

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
      if (init?.method === 'DELETE') {
        deleted.push(new URL(url).pathname.split('/').at(-1) ?? '');
        return jsonResponse({});
      }
      offsets.push(offsetOf(input));
      return jsonResponse(offsetOf(input) === 0 ? page0 : page1);
    }) as unknown as typeof fetch;

    await platinumProvider.deleteSnapshot(target);

    expect(offsets).toEqual([0, 50]);
    expect(deleted).toEqual(['duplicate-new', 'duplicate-old']);
  });

  test('does not issue a delete when the exact name is absent', async () => {
    let deletes = 0;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'DELETE') deletes += 1;
      return jsonResponse([tpl('unrelated')]);
    }) as unknown as typeof fetch;

    await expect(platinumProvider.deleteSnapshot('kortix-ppwarm-absent')).resolves.toBeUndefined();
    expect(deletes).toBe(0);
  });

  test('ignores per-template 404 races and continues deleting duplicates', async () => {
    const target = 'kortix-ppwarm-racing';
    const deleted: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
      const id = new URL(url).pathname.split('/').at(-1) ?? '';
      if (init?.method === 'DELETE') {
        deleted.push(id);
        return id === 'already-gone' ? jsonResponse({ error: 'not found' }, 404) : jsonResponse({});
      }
      return jsonResponse([
        namedTpl('already-gone', target),
        namedTpl('still-live', target),
      ]);
    }) as unknown as typeof fetch;

    await expect(platinumProvider.deleteSnapshot(target)).resolves.toBeUndefined();
    expect(deleted).toEqual(['already-gone', 'still-live']);
  });

  test('propagates a later listing failure without deleting a partial match', async () => {
    const target = 'kortix-ppwarm-partial';
    const page0 = [
      namedTpl('partial-match', target),
      ...Array.from({ length: 49 }, (_, i) => tpl(`filler-${i}`)),
    ];
    let deletes = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        deletes += 1;
        return jsonResponse({});
      }
      return offsetOf(input) === 0 ? jsonResponse(page0) : jsonResponse({ error: 'unavailable' }, 503);
    }) as unknown as typeof fetch;

    await expect(platinumProvider.deleteSnapshot(target)).rejects.toBeInstanceOf(PlatinumTemplateListingError);
    expect(deletes).toBe(0);
  });

  test('propagates non-404 deletion failures', async () => {
    const target = 'kortix-ppwarm-delete-failure';
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === 'DELETE'
        ? jsonResponse({ error: 'unavailable' }, 503)
        : jsonResponse([namedTpl('delete-failure', target)])) as unknown as typeof fetch;

    await expect(platinumProvider.deleteSnapshot(target)).rejects.toThrow(/503/);
  });

  // Platinum refuses to delete a template while any sandbox still pins its
  // rootfs (409 template_in_use; verified live 2026-09-22 against
  // api.platinum.dev). Daytona deletes a snapshot under live sandboxes, so
  // this outcome is Platinum-only. It is an expected state, not an outage:
  // callers must see a typed error, never a generic provider failure.
  test('maps 409 template_in_use to SnapshotInUseError and still deletes free duplicates', async () => {
    const target = 'kortix-default-in-use';
    const deleted: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
      const id = new URL(url).pathname.split('/').at(-1) ?? '';
      if (init?.method === 'DELETE') {
        deleted.push(id);
        return id === 'pinned'
          ? jsonResponse(
              {
                error: 'template still in use by 3 sandbox(es); delete those first',
                code: 'template_in_use',
                in_use: 3,
              },
              409,
            )
          : jsonResponse({});
      }
      return jsonResponse([namedTpl('pinned', target), namedTpl('free-duplicate', target)]);
    }) as unknown as typeof fetch;

    const error = await platinumProvider.deleteSnapshot(target).then(
      () => null,
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(SnapshotInUseError);
    expect((error as InstanceType<typeof SnapshotInUseError>).inUse).toBe(3);
    expect((error as InstanceType<typeof SnapshotInUseError>).snapshotName).toBe(target);
    expect(deleted).toEqual(['pinned', 'free-duplicate']);
  });

  test('a 409 that is not template_in_use stays a generic failure', async () => {
    const target = 'kortix-default-building';
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === 'DELETE'
        ? jsonResponse({ error: 'build in progress', code: 'build_in_progress' }, 409)
        : jsonResponse([namedTpl('building', target)])) as unknown as typeof fetch;

    const error = await platinumProvider.deleteSnapshot(target).then(
      () => null,
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(SnapshotInUseError);
    expect(String(error)).toMatch(/409/);
  });
});

// ─── Exact-name lookups (GET /v1/templates?name=) ────────────────────────────
// Measured 2026-10-02: the first session after each Kortix deploy walked the
// Kortix Dev org's 1,671 templates (34 pages × ~250 ms) to resolve its image,
// and `image:resolved` took 8.7 s. A control plane that honours `?name=`
// answers every name lookup in ONE request; one that ignores it gets the old
// walk with the exact same number of requests.

function urlOf(input: RequestInfo | URL): URL {
  const raw =
    typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
  return new URL(raw, 'https://platinum.test');
}

/** A control plane that honours the name filter over `rows` (newest first). */
function nameFilteringServer(
  rows: Array<{ id: string; name: string; state: string }>,
  log: string[],
) {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = urlOf(input);
    log.push(`${init?.method ?? 'GET'} ${url.pathname}${url.search}`);
    if ((init?.method ?? 'GET') === 'DELETE') return jsonResponse({ ok: true });
    const name = url.searchParams.get('name');
    const offset = Number(url.searchParams.get('offset') ?? '0');
    const limit = Number(url.searchParams.get('limit') ?? '50');
    const visible = name === null ? rows : rows.filter((t) => t.name === name);
    return jsonResponse(visible.slice(offset, offset + limit));
  }) as unknown as typeof fetch;
}

/** 1,671 templates, the sought ones far past page 1 (oldest last). */
function bigOrg(): Array<{ id: string; name: string; state: string }> {
  const rows = Array.from({ length: 1671 }, (_, i) => namedTpl(`id-${i}`, `kortix-default-${i}`));
  return rows;
}

describe('exact-name lookups — one request on a control plane that honours ?name=', () => {
  test('findTemplateByName: one request, carrying the name, newest first', async () => {
    const log: string[] = [];
    const rows = [
      namedTpl('new', 'kortix-default-x'),
      ...bigOrg(),
      namedTpl('old', 'kortix-default-x'),
    ];
    globalThis.fetch = nameFilteringServer(rows, log);
    const found = await findTemplateByName('kortix-default-x');
    expect(found?.id).toBe('new');
    expect(log).toEqual(['GET /v1/templates?limit=50&offset=0&name=kortix-default-x']);
  });

  test('a definitively absent name is one request, not a walk of 34 pages', async () => {
    const log: string[] = [];
    globalThis.fetch = nameFilteringServer(bigOrg(), log);
    expect(await findTemplateByName('kortix-default-gone')).toBeNull();
    expect(log).toHaveLength(1);
  });

  test('getSnapshotState of a template deep in a big org is one request', async () => {
    const log: string[] = [];
    globalThis.fetch = nameFilteringServer(bigOrg(), log);
    expect(await platinumProvider.getSnapshotState('kortix-default-1600')).toBe('active');
    expect(log).toHaveLength(1);
  });

  test('deleteSnapshot: one lookup, then DELETE every duplicate of that name only', async () => {
    const log: string[] = [];
    const rows = [
      namedTpl('dup-a', 'kortix-default-old'),
      ...bigOrg(),
      namedTpl('dup-b', 'kortix-default-old'),
    ];
    globalThis.fetch = nameFilteringServer(rows, log);
    await platinumProvider.deleteSnapshot('kortix-default-old');
    expect(log).toEqual([
      'GET /v1/templates?limit=50&offset=0&name=kortix-default-old',
      'DELETE /v1/templates/dup-a',
      'DELETE /v1/templates/dup-b',
    ]);
  });

  test('findFirstActiveSnapshot: the first candidate active → one request', async () => {
    const log: string[] = [];
    globalThis.fetch = nameFilteringServer(bigOrg(), log);
    expect(
      await platinumProvider.findFirstActiveSnapshot(['kortix-default-1500', 'kortix-default-3']),
    ).toBe('kortix-default-1500');
    expect(log).toHaveLength(1);
  });

  test('findFirstActiveSnapshot: keeps candidate priority without walking the list', async () => {
    const log: string[] = [];
    const rows = bigOrg().map((t) =>
      t.name === 'kortix-default-7' ? { ...t, state: 'building' } : t,
    );
    globalThis.fetch = nameFilteringServer(rows, log);
    const result = await platinumProvider.findFirstActiveSnapshot([
      'kortix-default-missing',
      'kortix-default-7',
      'kortix-default-1200',
      'kortix-default-5',
    ]);
    // missing → absent, 7 → building (not active), 1200 → active: priority wins over 5.
    expect(result).toBe('kortix-default-1200');
    expect(log.every((line) => line.includes('&name='))).toBe(true);
    expect(log).toHaveLength(4);
  });

  test('a lookup failure is a listing error, never "absent"', async () => {
    globalThis.fetch = (async () =>
      jsonResponse({ error: 'boom' }, 500)) as unknown as typeof fetch;
    await expect(findTemplateByName('x')).rejects.toBeInstanceOf(PlatinumTemplateListingError);
  });

  test('an auth failure on the name lookup propagates verbatim', async () => {
    globalThis.fetch = (async () =>
      jsonResponse({ error: 'unauthorized' }, 401)) as unknown as typeof fetch;
    await expect(findTemplateByName('x')).rejects.toThrow(/-> 401/);
  });
});

describe('a control plane that ignores ?name= keeps the old walk, request for request', () => {
  test('the probe is reused as page 0: a name on page 2 costs 2 requests, as before', async () => {
    const page0 = Array.from({ length: 50 }, (_, i) => tpl(`filler-${i}`));
    const page1 = [tpl('kortix-ppwarm-OLD')];
    const seen: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = urlOf(input);
      seen.push(url.search);
      return jsonResponse(offsetOf(input) === 0 ? page0 : page1);
    }) as unknown as typeof fetch;
    expect((await findTemplateByName('kortix-ppwarm-OLD'))?.id).toBe('id-kortix-ppwarm-OLD');
    expect(seen).toEqual(['?limit=50&offset=0&name=kortix-ppwarm-OLD', '?limit=50&offset=50']);
  });

  test('walks past 2,000 templates without throwing (the old 40-page cap)', async () => {
    const rows = Array.from({ length: 2300 }, (_, i) => tpl(`t-${i}`));
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const offset = offsetOf(input);
      return jsonResponse(rows.slice(offset, offset + 50));
    }) as unknown as typeof fetch;
    expect((await findTemplateByName('t-2299'))?.id).toBe('id-t-2299');
  });
});
