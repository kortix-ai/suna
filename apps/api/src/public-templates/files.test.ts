import { beforeEach, describe, expect, mock, test } from 'bun:test';

import type { TemplateCatalogEntry } from '../templates/catalog';

/**
 * Every request GitHub was asked to make, and what it was told to answer.
 * The module under test reaches the network through exactly one seam
 * (`githubFetch`), which is what makes it testable without one.
 */
const requested: string[] = [];
let treeResponse: { ok: boolean; body: unknown } = { ok: true, body: { tree: [] } };
let rawResponse: { ok: boolean; text: string } = { ok: true, text: '' };
let throwOnFetch = false;

mock.module('../shared/github-fetch', () => ({
  githubFetch: async (input: string) => {
    requested.push(input);
    if (throwOnFetch) throw new Error('network down');
    if (input.includes('api.github.com')) {
      return {
        ok: treeResponse.ok,
        json: async () => treeResponse.body,
      } as unknown as Response;
    }
    return { ok: rawResponse.ok, text: async () => rawResponse.text } as unknown as Response;
  },
}));

const {
  __clearTemplateFileMemo,
  defaultTemplateFile,
  listTemplateFiles,
  readTemplateFile,
} = await import('./files');

const TEMPLATE = {
  slug: 'sre-oncall',
  repo: 'acme/sre-oncall',
  resolved_sha: '7ad17b3d02aee7f7859370679cd353dc0916fc6c',
} as unknown as TemplateCatalogEntry;

function blob(path: string, size = 10) {
  return { path, type: 'blob', size };
}

beforeEach(() => {
  requested.length = 0;
  throwOnFetch = false;
  treeResponse = { ok: true, body: { tree: [] } };
  rawResponse = { ok: true, text: '' };
  __clearTemplateFileMemo();
});

describe('listTemplateFiles', () => {
  test('reads the tree at the PINNED sha, never at a branch', async () => {
    await listTemplateFiles(TEMPLATE);
    expect(requested[0]).toBe(
      'https://api.github.com/repos/acme/sre-oncall/git/trees/7ad17b3d02aee7f7859370679cd353dc0916fc6c?recursive=1',
    );
  });

  test('keeps blobs, drops trees, binaries and anything oversized', async () => {
    treeResponse = {
      ok: true,
      body: {
        tree: [
          blob('README.md'),
          blob('kortix.yaml'),
          blob('LICENSE'), // no extension — text by convention
          { path: '.kortix', type: 'tree' }, // a directory is not a file
          blob('assets/logo.png'), // binary: the viewer cannot render it
          blob('bun.lock'), // binary-ish lockfile
          blob('huge.md', 900 * 1024), // over the byte cap
        ],
      },
    };
    const files = await listTemplateFiles(TEMPLATE);
    expect(files.map((f) => f.path)).toEqual(['README.md', 'kortix.yaml', 'LICENSE']);
  });

  test('a GitHub failure degrades to no files instead of throwing', async () => {
    // The tree enriches the page; the catalog already carries what the template
    // declares. A rate limit must not 500 the whole detail page.
    treeResponse = { ok: false, body: {} };
    expect(await listTemplateFiles(TEMPLATE)).toEqual([]);

    __clearTemplateFileMemo();
    throwOnFetch = true;
    expect(await listTemplateFiles(TEMPLATE)).toEqual([]);
  });

  test('a second read is memoized — the pinned sha can never change', async () => {
    treeResponse = { ok: true, body: { tree: [blob('README.md')] } };
    await listTemplateFiles(TEMPLATE);
    await listTemplateFiles(TEMPLATE);
    expect(requested).toHaveLength(1);
  });
});

describe('readTemplateFile', () => {
  beforeEach(() => {
    treeResponse = { ok: true, body: { tree: [blob('README.md'), blob('docs/a.md')] } };
  });

  test('serves a listed file from the pinned raw URL', async () => {
    rawResponse = { ok: true, text: '# SRE On-Call' };
    expect(await readTemplateFile(TEMPLATE, 'README.md')).toBe('# SRE On-Call');
    expect(requested.at(-1)).toBe(
      'https://raw.githubusercontent.com/acme/sre-oncall/7ad17b3d02aee7f7859370679cd353dc0916fc6c/README.md',
    );
  });

  test('refuses any path the template does not publish', async () => {
    rawResponse = { ok: true, text: 'secret' };
    for (const path of ['../../etc/passwd', '/etc/passwd', 'docs/../README.md', 'nope.md']) {
      expect(await readTemplateFile(TEMPLATE, path)).toBeNull();
    }
    // None of them reached the network: the listing is the allowlist, so the
    // route cannot be used to probe a repository.
    expect(requested.filter((url) => url.includes('raw.githubusercontent'))).toHaveLength(0);
  });

  test('rejects content that turns out to be binary', async () => {
    rawResponse = { ok: true, text: 'PK\0\0binary' };
    expect(await readTemplateFile(TEMPLATE, 'README.md')).toBeNull();
  });
});

describe('defaultTemplateFile', () => {
  const files = (...paths: string[]) => paths.map((path) => ({ path, size: 1 }));

  test('opens on the root README before anything else', () => {
    expect(defaultTemplateFile(files('kortix.yaml', 'docs/README.md', 'README.md'))).toBe(
      'README.md',
    );
  });

  test('falls back to a nested README, then the manifest, then the first file', () => {
    expect(defaultTemplateFile(files('kortix.yaml', 'docs/README.md'))).toBe('docs/README.md');
    expect(defaultTemplateFile(files('agents/sre.md', 'kortix.yaml'))).toBe('kortix.yaml');
    expect(defaultTemplateFile(files('agents/sre.md'))).toBe('agents/sre.md');
    expect(defaultTemplateFile([])).toBeUndefined();
  });
});
