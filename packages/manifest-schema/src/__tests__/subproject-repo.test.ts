/**
 * `parseSubprojectRepo` — the one normalizer the subproject submit route and the submit
 * modal share.
 *
 * Its output reaches two places that make the rejections security-relevant, not
 * cosmetic: a committed manifest, and a URL the server fetches. So a value that
 * does not identify exactly one GitHub repository must return null rather than
 * be coerced into something plausible.
 */
import { describe, expect, test } from 'bun:test';
import { parseSubprojectRepo } from '../constants';

describe('parseSubprojectRepo — accepted forms', () => {
  const bare = { owner: 'acme', repo: 'seo-subproject', ref: null };
  const accepted: Array<[string, string, ReturnType<typeof parseSubprojectRepo>]> = [
    ['bare owner/repo', 'acme/seo-subproject', bare],
    ['surrounding whitespace', '  acme/seo-subproject  ', bare],
    ['browser URL', 'https://github.com/acme/seo-subproject', bare],
    ['browser URL, http', 'http://github.com/acme/seo-subproject', bare],
    ['browser URL with www', 'https://www.github.com/acme/seo-subproject', bare],
    ['trailing slash', 'https://github.com/acme/seo-subproject/', bare],
    ['clone URL', 'https://github.com/acme/seo-subproject.git', bare],
    ['scp-style remote', 'git@github.com:acme/seo-subproject.git', bare],
    ['ssh URL', 'ssh://git@github.com/acme/seo-subproject.git', bare],
    ['git protocol', 'git://github.com/acme/seo-subproject.git', bare],
    ['github: scheme', 'github:acme/seo-subproject', bare],
    ['query string dropped', 'https://github.com/acme/seo-subproject?tab=readme', bare],
    ['fragment dropped', 'https://github.com/acme/seo-subproject#readme', bare],
    ['dots in the repo name', 'acme/seo.subproject', { owner: 'acme', repo: 'seo.subproject', ref: null }],
    ['underscores', 'a_c/s_c', { owner: 'a_c', repo: 's_c', ref: null }],
  ];
  for (const [label, input, expected] of accepted) {
    test(label, () => expect(parseSubprojectRepo(input)).toEqual(expected));
  }
});

describe('parseSubprojectRepo — a pinned ref', () => {
  test('a bare address can pin a tag', () => {
    expect(parseSubprojectRepo('acme/seo-subproject@v1.2.0')).toEqual({
      owner: 'acme',
      repo: 'seo-subproject',
      ref: 'v1.2.0',
    });
  });

  test('a clone URL can pin a tag — the ref is split before .git is stripped', () => {
    expect(parseSubprojectRepo('https://github.com/acme/seo-subproject.git@v1')).toEqual({
      owner: 'acme',
      repo: 'seo-subproject',
      ref: 'v1',
    });
  });

  test('a branch name pins too', () => {
    expect(parseSubprojectRepo('acme/seo-subproject@main')?.ref).toBe('main');
  });

  test('an empty ref after @ is rejected, not read as unpinned', () => {
    expect(parseSubprojectRepo('acme/seo-subproject@')).toBeNull();
  });

  test('a ref with a slash is rejected — this form cannot express it unambiguously', () => {
    expect(parseSubprojectRepo('acme/seo-subproject@release/1.x')).toBeNull();
  });
});

describe('parseSubprojectRepo — rejected', () => {
  const rejected: Array<[string, string]> = [
    ['empty', ''],
    ['whitespace only', '   '],
    ['a bare word', 'acme'],
    ['three segments', 'acme/seo-subproject/extra'],
    ['a deep GitHub path', 'https://github.com/acme/seo-subproject/tree/main/src'],
    // The whole point: another host must never pass as owner/repo.
    ['a non-GitHub host', 'https://gitlab.com/acme/seo-subproject'],
    ['a look-alike host', 'https://github.com.evil.com/acme/seo-subproject'],
    ['a bare non-GitHub URL', 'https://evil.com/acme/seo-subproject'],
    // Path traversal into the raw-content URL the server builds.
    ['a traversal segment', '../etc/passwd'],
    ['a dot owner', './repo'],
    ['a double-dot repo', 'acme/..'],
    ['an absolute path', '/etc/passwd'],
    ['a doubled separator', 'acme//seo-subproject'],
    ['a scheme left behind', 'file:///etc/passwd'],
    ['whitespace inside', 'acme/seo subproject'],
    ['a colon inside', 'acme:seo/subproject'],
    ['a character outside the name set', 'acme/seo$subproject'],
  ];
  for (const [label, input] of rejected) {
    test(label, () => expect(parseSubprojectRepo(input)).toBeNull());
  }
});
