import { describe, expect, test } from 'bun:test';

import { unionRequiredAliases } from './prompt-connector-preflight';

// The union is the part of the gate most likely to silently lose a source, and a
// gate that checks the empty set passes everything — so it gets its own test
// rather than only being covered through the proxy.
describe('unionRequiredAliases', () => {
  test('a session-declared alias counts even with nothing connected to it', () => {
    // The case the whole column exists for. A binding row cannot express it
    // (profile_id is NOT NULL), so if this source were dropped, selecting an
    // unconnected connector in the UI would record an intent nothing ever reads.
    expect(
      unionRequiredAliases({ sessionRequired: ['gmail'], manifestRequired: [], boundAliases: [] }),
    ).toEqual(['gmail']);
  });

  test('the running agent manifest counts', () => {
    // Canonical, not the public spelling: `slack` is stored as `kortix_slack`,
    // and the resolver this feeds looks the alias up by its stored slug.
    expect(
      unionRequiredAliases({ sessionRequired: null, manifestRequired: ['slack'], boundAliases: [] }),
    ).toEqual(['kortix_slack']);
  });

  test('an existing binding counts — it catches a connection revoked after create', () => {
    // Neither of the other two sources notices that: the manifest never named it
    // and the caller never declared it, but the session was built to use it.
    expect(
      unionRequiredAliases({ sessionRequired: null, manifestRequired: [], boundAliases: ['gmail'] }),
    ).toEqual(['gmail']);
  });

  test('all three merge, and an alias in two of them appears once', () => {
    const result = unionRequiredAliases({
      sessionRequired: ['gmail'],
      manifestRequired: ['gmail', 'slack'],
      boundAliases: ['notion'],
    });
    expect(result.sort()).toEqual(['gmail', 'kortix_slack', 'notion']);
  });

  test('aliases are canonicalised, so a public spelling is not counted twice', () => {
    // `email` and `kortix_email` are the same connector; treating them as two
    // would ask the pre-flight to resolve an alias that does not exist.
    expect(
      unionRequiredAliases({
        sessionRequired: ['email'],
        manifestRequired: ['kortix_email'],
        boundAliases: [],
      }),
    ).toHaveLength(1);
  });

  test('blanks and whitespace never become a required alias', () => {
    // An empty alias would send the resolver looking for a connector named "",
    // fail to find one, and refuse every prompt in the session.
    expect(
      unionRequiredAliases({
        sessionRequired: ['', '   '],
        manifestRequired: [],
        boundAliases: [''],
      }),
    ).toEqual([]);
  });

  test('nothing required anywhere is the empty set, not a false requirement', () => {
    expect(
      unionRequiredAliases({ sessionRequired: null, manifestRequired: [], boundAliases: [] }),
    ).toEqual([]);
    expect(
      unionRequiredAliases({ sessionRequired: undefined, manifestRequired: [], boundAliases: [] }),
    ).toEqual([]);
  });
});
