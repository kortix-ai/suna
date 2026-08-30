/**
 * `parseCraftRepo` — the one normalizer the craft submit route and the submit
 * modal share.
 *
 * Its output reaches two places that make the rejections security-relevant, not
 * cosmetic: a committed manifest, and a URL the server fetches. So a value that
 * does not identify exactly one GitHub repository must return null rather than
 * be coerced into something plausible.
 */
import { describe, expect, test } from 'bun:test';
import { parseCraftRepo } from '../constants';

describe('parseCraftRepo — accepted forms', () => {
  const bare = { owner: 'acme', repo: 'seo-craft', ref: null };
  const accepted: Array<[string, string, ReturnType<typeof parseCraftRepo>]> = [
    ['bare owner/repo', 'acme/seo-craft', bare],
    ['surrounding whitespace', '  acme/seo-craft  ', bare],
    ['browser URL', 'https://github.com/acme/seo-craft', bare],
    ['browser URL, http', 'http://github.com/acme/seo-craft', bare],
    ['browser URL with www', 'https://www.github.com/acme/seo-craft', bare],
    ['trailing slash', 'https://github.com/acme/seo-craft/', bare],
    ['clone URL', 'https://github.com/acme/seo-craft.git', bare],
    ['scp-style remote', 'git@github.com:acme/seo-craft.git', bare],
    ['ssh URL', 'ssh://git@github.com/acme/seo-craft.git', bare],
    ['git protocol', 'git://github.com/acme/seo-craft.git', bare],
    ['github: scheme', 'github:acme/seo-craft', bare],
    ['query string dropped', 'https://github.com/acme/seo-craft?tab=readme', bare],
    ['fragment dropped', 'https://github.com/acme/seo-craft#readme', bare],
    ['dots in the repo name', 'acme/seo.craft', { owner: 'acme', repo: 'seo.craft', ref: null }],
    ['underscores', 'a_c/s_c', { owner: 'a_c', repo: 's_c', ref: null }],
  ];
  for (const [label, input, expected] of accepted) {
    test(label, () => expect(parseCraftRepo(input)).toEqual(expected));
  }
});

describe('parseCraftRepo — a pinned ref', () => {
  test('a bare address can pin a tag', () => {
    expect(parseCraftRepo('acme/seo-craft@v1.2.0')).toEqual({
      owner: 'acme',
      repo: 'seo-craft',
      ref: 'v1.2.0',
    });
  });

  test('a clone URL can pin a tag — the ref is split before .git is stripped', () => {
    expect(parseCraftRepo('https://github.com/acme/seo-craft.git@v1')).toEqual({
      owner: 'acme',
      repo: 'seo-craft',
      ref: 'v1',
    });
  });

  test('a branch name pins too', () => {
    expect(parseCraftRepo('acme/seo-craft@main')?.ref).toBe('main');
  });

  test('an empty ref after @ is rejected, not read as unpinned', () => {
    expect(parseCraftRepo('acme/seo-craft@')).toBeNull();
  });

  test('a ref with a slash is rejected — this form cannot express it unambiguously', () => {
    expect(parseCraftRepo('acme/seo-craft@release/1.x')).toBeNull();
  });
});

describe('parseCraftRepo — rejected', () => {
  const rejected: Array<[string, string]> = [
    ['empty', ''],
    ['whitespace only', '   '],
    ['a bare word', 'acme'],
    ['three segments', 'acme/seo-craft/extra'],
    ['a deep GitHub path', 'https://github.com/acme/seo-craft/tree/main/src'],
    // The whole point: another host must never pass as owner/repo.
    ['a non-GitHub host', 'https://gitlab.com/acme/seo-craft'],
    ['a look-alike host', 'https://github.com.evil.com/acme/seo-craft'],
    ['a bare non-GitHub URL', 'https://evil.com/acme/seo-craft'],
    // Path traversal into the raw-content URL the server builds.
    ['a traversal segment', '../etc/passwd'],
    ['a dot owner', './repo'],
    ['a double-dot repo', 'acme/..'],
    ['an absolute path', '/etc/passwd'],
    ['a doubled separator', 'acme//seo-craft'],
    ['a scheme left behind', 'file:///etc/passwd'],
    ['whitespace inside', 'acme/seo craft'],
    ['a colon inside', 'acme:seo/craft'],
    ['a character outside the name set', 'acme/seo$craft'],
  ];
  for (const [label, input] of rejected) {
    test(label, () => expect(parseCraftRepo(input)).toBeNull());
  }
});
