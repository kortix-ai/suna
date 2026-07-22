import { describe, expect, test } from 'bun:test';

import {
  DISCOVERY_PATHS,
  SITE_LINK_HEADER,
  SITE_LINK_VALUES,
  markdownAlternateLinkValue,
} from './link-header';

// RFC 8288 link-value: <uri-reference> followed by ;-delimited parameters.
const LINK_VALUE = /^<[^>]+>(?:\s*;\s*[a-zA-Z*-]+="[^"]*")+$/;

// IANA Link Relations registry, plus `api-catalog` registered by RFC 9727 §4.
const REGISTERED_RELATIONS = new Set([
  'api-catalog',
  'service-doc',
  'service-desc',
  'describedby',
  'terms-of-service',
  'alternate',
  'canonical',
]);

function relationOf(value: string): string {
  return value.match(/rel="([^"]+)"/)?.[1] ?? '';
}

describe('site link header', () => {
  test('every link-value parses as RFC 8288', () => {
    for (const value of SITE_LINK_VALUES) {
      expect(value).toMatch(LINK_VALUE);
    }
  });

  test('only IANA-registered relation types are advertised', () => {
    for (const value of SITE_LINK_VALUES) {
      expect(REGISTERED_RELATIONS.has(relationOf(value))).toBe(true);
    }
  });

  test('advertises the api catalog, docs, llms.txt and terms', () => {
    expect(SITE_LINK_VALUES.map(relationOf).sort()).toEqual([
      'api-catalog',
      'describedby',
      'service-doc',
      'terms-of-service',
    ]);
  });

  test('every advertised target is a root-relative path', () => {
    for (const value of SITE_LINK_VALUES) {
      expect(value.startsWith('</')).toBe(true);
    }
  });

  test('header joins values with a comma so a single field carries all of them', () => {
    expect(SITE_LINK_HEADER).toBe(SITE_LINK_VALUES.join(', '));
  });

  test('markdown alternate declares the markdown media type', () => {
    expect(markdownAlternateLinkValue('/markdown/pricing.md')).toBe(
      '</markdown/pricing.md>; rel="alternate"; type="text/markdown"',
    );
  });

  test('discovery paths are the spec-mandated well-known locations', () => {
    expect(DISCOVERY_PATHS.apiCatalog).toBe('/.well-known/api-catalog');
    expect(DISCOVERY_PATHS.authorizationServer).toBe(
      '/.well-known/oauth-authorization-server',
    );
    expect(DISCOVERY_PATHS.protectedResource).toBe(
      '/.well-known/oauth-protected-resource',
    );
    expect(DISCOVERY_PATHS.agentSkillsIndex).toBe(
      '/.well-known/agent-skills/index.json',
    );
    expect(DISCOVERY_PATHS.authMd).toBe('/auth.md');
  });
});
