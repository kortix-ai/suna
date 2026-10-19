import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  EMOJIBASE_DATA_ASSETS,
  getEmojibaseDataOutputPaths,
  getEmojibaseDataSourcePaths,
} from '../../../scripts/emojibase-data.mjs';

/**
 * Where the emoji picker's data comes from.
 *
 * frimousse fetches the emojibase dataset from a URL at first open. Left at its
 * default that URL is `https://cdn.jsdelivr.net/npm/emojibase-data@latest` — a
 * third-party CDN, in the user's browser, at runtime. Kortix ships self-hosted,
 * so that default is wrong here on its own; what makes it a defect rather than a
 * preference is the failure mode. frimousse exposes `Loading` and `Empty` and no
 * error slot (see the tripwire at the bottom of this file), and on a cold cache
 * its loader is a bare `await` — a first open with the CDN unreachable leaves
 * the popover spinning forever with no message. An air-gapped deployment, a
 * restricted network, or any future `connect-src` CSP would hit exactly that.
 *
 * The fix is to serve the dataset from our own origin. That splits across four
 * files — the picker, the copy script, package.json and next.config.ts — and
 * every test below exists to hold one of the seams between them, because a
 * broken seam produces no error anywhere: it produces a picker that spins.
 */

const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const source = read('./emoji-picker.tsx');

/** Source with comments stripped, so prose describing a prop can never stand in
 *  for the prop. Same convention as emoji-picker.test.tsx. */
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const require_ = createRequire(import.meta.url);
const frimousseEntry = require_.resolve('frimousse');
const frimousseDist = readFileSync(frimousseEntry, 'utf8');

/**
 * The file names frimousse appends to `emojibaseUrl`, read out of the installed
 * package instead of assumed. Its dist builds both as
 * ``(base, locale) => `${base}/${locale}/<file>` ``, which is the whole URL
 * contract this file is holding us to.
 */
const FRIMOUSSE_FILES = [
  ...frimousseDist.matchAll(/\(\w+,\s*\w+\)\s*=>\s*`\$\{\w+\}\/\$\{\w+\}\/([\w.]+)`/g),
].map((match) => match[1]);

/**
 * The opening `<Frimousse.Root …>` tag. Scanned rather than matched with a lazy
 * regex: an attribute value may legitimately contain `>` inside a `{…}`
 * expression, and a lazy `[\s\S]*?` anchored on the tag name would happily run
 * past the tag into the rest of the file.
 */
function openingTag(src: string, name: string): string {
  const start = src.indexOf(`<${name}`);
  if (start < 0) throw new Error(`<${name}> not found`);

  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const char = src[i];
    if (char === '{') depth++;
    else if (char === '}') depth--;
    else if (char === '>' && depth === 0) return src.slice(start, i + 1);
  }

  throw new Error(`unterminated <${name}>`);
}

const ROOT_TAG = openingTag(code, 'Frimousse.Root');
const emojibaseUrl = ROOT_TAG.match(/\bemojibaseUrl="([^"]*)"/)?.[1];
const locale = ROOT_TAG.match(/\blocale="([^"]*)"/)?.[1];

const packageJson = JSON.parse(read('../../../package.json')) as {
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
};
const nextConfig = read('../../../next.config.ts');

describe('emoji picker data source', () => {
  test('frimousse still builds its URLs the way this file assumes', () => {
    // Guard the guard: every path assertion below is derived from these two
    // names, so a regex that silently stopped matching would make the rest of
    // the file vacuous rather than red.
    expect(FRIMOUSSE_FILES).toEqual(['data.json', 'messages.json']);
  });

  test('the picker fetches the dataset from our own origin, never a CDN', () => {
    // A root-relative URL is the assertion, not merely "some URL was passed":
    // pointing `emojibaseUrl` at unpkg instead of jsDelivr would satisfy a
    // presence check and change nothing about the air-gapped failure.
    expect(emojibaseUrl).toMatch(/^\/[a-z0-9-]+$/);
    expect(code).not.toMatch(/jsdelivr|unpkg|cdnjs/i);
  });

  test('the locale it renders is declared, not inherited from a default', () => {
    // We ship exactly one locale's directory. frimousse defaults to `en`, so
    // omitting this works right up until someone adds `locale={userLocale}` —
    // at which point every other locale 404s and the picker spins forever, with
    // the four files below still perfectly consistent with each other.
    expect(locale).toBe('en');
  });

  test('every URL frimousse will request is a file we serve from public/', () => {
    // The seam this whole fix turns on. It fails if the prop is dropped, if the
    // locale moves, if the served path is renamed, or if either file is missing
    // from the copy list.
    expect(EMOJIBASE_DATA_ASSETS.map((asset) => asset.url)).toEqual(
      FRIMOUSSE_FILES.map((file) => `${emojibaseUrl}/${locale}/${file}`),
    );
  });

  test('each served URL is exactly where the copy writes the file', () => {
    // `url` is what the browser asks for and `to` is what lands on disk. Nothing
    // in Next ties them together — `public/x/y.json` is served at `/x/y.json`
    // by convention — so the two are pinned to each other here.
    for (const asset of EMOJIBASE_DATA_ASSETS) {
      expect(asset.to).toBe(`../public${asset.url}`);
    }
  });

  test('the files the copy reads are actually installed', () => {
    // Catches the dependency being dropped, and catches a `from` path that
    // points at a file the package does not ship — both of which surface at
    // build time as a thrown error rather than in a test, but only if the
    // dependency is declared at all.
    expect(packageJson.dependencies['emojibase-data']).toBeDefined();

    const sources = getEmojibaseDataSourcePaths();
    expect(sources).toHaveLength(EMOJIBASE_DATA_ASSETS.length);
    for (const path of sources) {
      expect({ path, exists: existsSync(path) }).toEqual({ path, exists: true });
    }
  });

  test('the copy targets land under public/, not anywhere else', () => {
    for (const output of getEmojibaseDataOutputPaths()) {
      expect(output).toContain('/apps/web/public/');
    }
  });
});

describe('emoji picker dataset shape', () => {
  const parse = (file: string) =>
    JSON.parse(
      readFileSync(
        getEmojibaseDataSourcePaths().find((path) => path.endsWith(`/${file}`))!,
        'utf8',
      ),
    );

  test('data.json is the dataset frimousse parses, not a sibling in the same folder', () => {
    // `emojibase-data/en/` also ships `compact.json`, which is the same 1949
    // emoji keyed `unicode` instead of `emoji` and carries no `version`. Wiring
    // that one instead is a plausible slip, it copies and serves and parses
    // fine, and what ships is a picker whose every cell is blank. frimousse
    // keeps only rows with a `group`, reads `.emoji`, and filters on `.version`
    // against the browser's supported emoji version — so those three fields are
    // what "the right file" means.
    const data = parse('data.json') as Record<string, unknown>[];

    expect(Array.isArray(data)).toBe(true);

    const grouped = data.filter((entry) => 'group' in entry);
    expect(grouped.length).toBeGreaterThan(1000);
    expect(
      grouped.every((entry) => typeof entry.emoji === 'string' && entry.emoji.length > 0),
    ).toBe(true);
    expect(grouped.every((entry) => typeof entry.version === 'number')).toBe(true);
    expect(grouped.every((entry) => typeof entry.label === 'string')).toBe(true);
  });

  test('data.json carries the skin-tone variations the footer selector switches', () => {
    // frimousse builds its skin-tone map from `skins[].tone`, and `compact.json`
    // has skins with no `tone` at all. Without this the SkinToneSelector renders
    // and does nothing.
    const data = parse('data.json') as { skins?: { tone?: unknown }[] }[];
    const withTones = data.filter((entry) => entry.skins?.some((s) => typeof s.tone === 'number'));

    expect(withTones.length).toBeGreaterThan(100);
  });

  test('messages.json carries the three collections frimousse reads', () => {
    // It reads `subgroups` (to find the country-flag subgroup), `groups` (the
    // category headers) and `skinTones` (the selector's labels). A missing one
    // throws inside the loader, which is the invisible failure again.
    const messages = parse('messages.json') as Record<string, unknown[]>;

    expect(Object.keys(messages).sort()).toEqual(['groups', 'skinTones', 'subgroups']);
    for (const [key, value] of Object.entries(messages)) {
      expect({ key, empty: value.length === 0 }).toEqual({ key, empty: false });
    }
    expect(
      (messages.subgroups as { key: string }[]).some((group) => group.key === 'country-flag'),
    ).toBe(true);
  });
});

describe('emoji picker data is guaranteed at runtime', () => {
  test('the copy runs on both dev and build, not just one of them', () => {
    // `public/emojibase/` is gitignored, like every other copied asset here, so
    // nothing but this step puts the files on disk. Wiring only `build` ships a
    // picker that works in production and spins for every developer.
    for (const script of ['dev', 'build']) {
      expect({
        script,
        wired: packageJson.scripts[script]?.includes('copy-emojibase-data.mjs'),
      }).toEqual({ script, wired: true });
    }
  });

  test('a build that did not copy the data fails instead of shipping a dead picker', () => {
    // The npm scripts above are bypassed by anything that invokes `next build`
    // directly, which is how the viewer wasm assets were silently 404ing before
    // the same guard was added for them. Loading the config repeats the copy and
    // then verifies the outputs exist — the emoji data has no visible failure of
    // its own, so this is the only thing that can say it is missing.
    const guardStart = nextConfig.indexOf('getEmojibaseDataOutputPaths()');
    const guard = guardStart < 0 ? '' : nextConfig.slice(guardStart, guardStart + 800);

    expect(nextConfig).toContain("from './scripts/emojibase-data.mjs'");
    expect(nextConfig).toContain('copyEmojibaseData()');
    // Existence-checked, and the check throws. Not anchored on a variable name:
    // a rename is not a regression, and a test that a rename can defeat is one
    // a deletion can defeat too.
    expect(guard).toContain('!fs.existsSync(output)');
    expect(guard).toMatch(/if \(missing\w*\.length > 0\) \{\s*throw new Error\(/);
  });
});

describe('frimousse capability tripwire', () => {
  test('frimousse still has no error slot, which is why the fetch must not fail', () => {
    // The premise of everything above. frimousse renders `Loading` until data
    // arrives and `Empty` when a search matches nothing; there is no slot for
    // "the fetch failed", and its cold-cache path does not catch. If a future
    // version adds one, this goes red — and the picker should wire it, rather
    // than continuing to rely on the fetch never failing.
    const types = readFileSync(join(dirname(frimousseEntry), 'index.d.ts'), 'utf8');

    expect(types).toContain('EmojiPickerLoading');
    expect(types).toContain('EmojiPickerEmpty');
    expect(types).not.toMatch(/EmojiPicker(Error|Failure|Retry)\b/);
  });
});
