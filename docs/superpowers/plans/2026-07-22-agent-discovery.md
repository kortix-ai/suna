# Agent Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish truthful, machine-readable agent-discovery metadata at the standard entry points on kortix.com so an agent arriving with no prior knowledge can find the API, its docs, its auth story, and its content without scraping HTML.

**Architecture:** All artifacts are Next.js route handlers under `apps/web/src/app/(public)/well-known/…`, exposed at their spec-mandated `/.well-known/…` paths by rewrites in `next.config.ts` (dot-prefixed directories are ignored by the App Router, and static file serving cannot set content types like `application/linkset+json`). A new `src/lib/agent-discovery/` module tree holds all the facts; route handlers are thin wrappers over pure builder functions. Markdown content negotiation happens in middleware, which runs on the Edge runtime and therefore reads a committed, drift-tested JSON route map rather than the `node:fs`-backed content module.

**Tech Stack:** Next.js 15.5 App Router, TypeScript, `bun:test`, Zod-free plain builders, `node:crypto` for digests.

**Spec:** `docs/superpowers/specs/2026-07-22-agent-discovery-design.md`

## Global Constraints

- **Worktree:** all work happens in `/Users/jay/root/kortix/suna-is-it-agent-ready` on branch `is-it-agent-ready`. Never edit the primary checkout at `/Users/jay/root/kortix/suna`.
- **Working directory:** every command below runs from `apps/web` unless stated otherwise.
- **Truthfulness rule:** no discovery document may advertise a capability that does not exist in this repository. Specifically: no `openid-configuration` (Kortix issues opaque DB-row tokens, no `id_token`, no JWKS), no `jwks_uri`, no MCP server card, no scope beyond `profile`, no dynamic client registration endpoint.
- **Canonical origin:** `https://kortix.com` (from `src/lib/site-metadata.ts:10`). **API base:** `https://api.kortix.com/v1`.
- **Tests:** co-located `*.test.ts` beside the module, `bun:test`, run with `bun test <path>`. Every task ships its tests in the same commit.
- **No comments that restate code.** Comments explain *why*, matching the density of surrounding files.
- **Edge-safety rule:** anything imported by `src/middleware.ts` must not transitively import `node:fs`. This rules out `src/lib/seo/public-content.ts` and `src/lib/agent-discovery/endpoints.ts`.
- **Commit messages:** conventional commits, scope `web`. No AI attribution trailers of any kind.

---

### Task 1: Discovery constants and site-wide Link header

Foundation for every later task. `link-header.ts` is deliberately import-free because `next.config.ts` is evaluated outside the Next module graph and cannot resolve the `@/` alias.

**Files:**
- Create: `apps/web/src/lib/agent-discovery/link-header.ts`
- Create: `apps/web/src/lib/agent-discovery/endpoints.ts`
- Create: `apps/web/src/lib/agent-discovery/link-header.test.ts`
- Modify: `apps/web/next.config.ts` (imports at top; `headers()` at line 300)

**Interfaces:**
- Consumes: `CANONICAL_ORIGIN` from `@/lib/site-metadata`
- Produces:
  - `DISCOVERY_PATHS: Record<'apiCatalog'|'authorizationServer'|'protectedResource'|'agentSkillsIndex'|'authMd'|'docs'|'llmsTxt'|'terms', string>`
  - `SITE_LINK_VALUES: string[]`, `SITE_LINK_HEADER: string`
  - `markdownAlternateLinkValue(markdownPath: string): string`
  - `API_ORIGIN`, `API_BASE`, `OPENAPI_URL`, `API_HEALTH_URL`, `AGENT_INDEX_URL`: `string`
  - `OAUTH_ISSUER: string`, `OAUTH_ENDPOINTS: { authorization: string; token: string; userinfo: string }`
  - `OAUTH_SCOPES_SUPPORTED`, `OAUTH_GRANT_TYPES`, `OAUTH_RESPONSE_TYPES`, `OAUTH_CODE_CHALLENGE_METHODS`, `OAUTH_TOKEN_AUTH_METHODS`: `readonly string[]`
  - `siteUrl(path: string): string`

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/lib/agent-discovery/link-header.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/lib/agent-discovery/link-header.test.ts`
Expected: FAIL — `Cannot find module './link-header'`.

- [ ] **Step 3: Write `link-header.ts`**

Create `apps/web/src/lib/agent-discovery/link-header.ts`:

```ts
/**
 * Discovery paths and the site-wide RFC 8288 `Link` response header.
 *
 * This file MUST NOT import anything. `next.config.ts` is evaluated outside
 * the Next module graph and cannot resolve the `@/` alias, so it imports this
 * module by relative path. `endpoints.ts` depends on these constants rather
 * than the reverse.
 */

export const DISCOVERY_PATHS = {
  apiCatalog: '/.well-known/api-catalog',
  authorizationServer: '/.well-known/oauth-authorization-server',
  protectedResource: '/.well-known/oauth-protected-resource',
  agentSkillsIndex: '/.well-known/agent-skills/index.json',
  authMd: '/auth.md',
  docs: '/docs',
  llmsTxt: '/llms.txt',
  terms: '/legal',
} as const;

/**
 * `service-desc` is deliberately absent: the OpenAPI document lives on
 * api.kortix.com, a different origin, and belongs in the API catalog's linkset
 * where it can be anchored to the API it describes.
 */
export const SITE_LINK_VALUES: string[] = [
  `<${DISCOVERY_PATHS.apiCatalog}>; rel="api-catalog"`,
  `<${DISCOVERY_PATHS.docs}>; rel="service-doc"`,
  `<${DISCOVERY_PATHS.llmsTxt}>; rel="describedby"; type="text/plain"`,
  `<${DISCOVERY_PATHS.terms}>; rel="terms-of-service"`,
];

export const SITE_LINK_HEADER = SITE_LINK_VALUES.join(', ');

export function markdownAlternateLinkValue(markdownPath: string): string {
  return `<${markdownPath}>; rel="alternate"; type="text/markdown"`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test src/lib/agent-discovery/link-header.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Write `endpoints.ts`**

Create `apps/web/src/lib/agent-discovery/endpoints.ts`. Every value is verified against `apps/api/src/oauth/index.ts` — see the spec's "Established facts" table.

```ts
import { CANONICAL_ORIGIN } from '@/lib/site-metadata';

export const API_ORIGIN = 'https://api.kortix.com';
export const API_BASE = `${API_ORIGIN}/v1`;

export const OPENAPI_URL = `${API_BASE}/openapi.json`;
export const API_HEALTH_URL = `${API_BASE}/health`;
export const AGENT_INDEX_URL = `${CANONICAL_ORIGIN}/api/ai`;

/**
 * RFC 8414 §3 requires only that the metadata *document location* derive from
 * the issuer identifier; the endpoints it advertises may live on any host. So
 * the issuer is the web origin (metadata at
 * kortix.com/.well-known/oauth-authorization-server) while the endpoints are on
 * api.kortix.com. Kortix access tokens are opaque database rows with no `iss`
 * claim, so nothing can contradict this identifier.
 */
export const OAUTH_ISSUER = CANONICAL_ORIGIN;

export const OAUTH_ENDPOINTS = {
  authorization: `${API_BASE}/oauth/authorize`,
  token: `${API_BASE}/oauth/token`,
  userinfo: `${API_BASE}/oauth/userinfo`,
} as const;

/**
 * Only scopes the API actually enforces. `machines:read` appears in test
 * fixtures but is gated by nothing, so advertising it would invite agents to
 * request a scope that grants no additional access.
 */
export const OAUTH_SCOPES_SUPPORTED = ['profile'] as const;

export const OAUTH_RESPONSE_TYPES = ['code'] as const;
export const OAUTH_GRANT_TYPES = ['authorization_code', 'refresh_token'] as const;
export const OAUTH_CODE_CHALLENGE_METHODS = ['S256'] as const;
export const OAUTH_TOKEN_AUTH_METHODS = ['client_secret_post'] as const;

/** The token endpoint's per-client limit, mirrored into auth.md. */
export const OAUTH_TOKEN_RATE_LIMIT_PER_MINUTE = 20;

/**
 * Deliberately not `absoluteUrl` from `@/lib/seo/public-content`: that module
 * reads MDX sources with `node:fs`, and pulling it into every discovery route
 * would couple them to the content pipeline for one string concatenation.
 */
export function siteUrl(path: string): string {
  return `${CANONICAL_ORIGIN}${path === '/' ? '' : path}`;
}
```

- [ ] **Step 6: Wire the Link header into `next.config.ts`**

Add to the import block at the top of `apps/web/next.config.ts` (after the `path` import on line 7):

```ts
import { SITE_LINK_HEADER } from './src/lib/agent-discovery/link-header';
```

Then in `headers()` (line 300), add a new entry as the **first** element of the returned array, before the existing `Content-Security-Policy` entry:

```ts
      {
        // RFC 8288 discovery pointers for agents. Advertised site-wide so an
        // agent landing on any page — not just the homepage — can find the API
        // catalog, the docs, and the machine-readable content index.
        source: '/:path*',
        headers: [{ key: 'Link', value: SITE_LINK_HEADER }],
      },
```

- [ ] **Step 7: Verify the config still loads and the header is emitted**

Run: `bun run build 2>&1 | tail -20`
Expected: build completes without a config-load error.

Then run the dev server and check the header:

Run: `bun run dev &` then `curl -sI http://localhost:3000/ | grep -i '^link:'`
Expected: `link: </.well-known/api-catalog>; rel="api-catalog", </docs>; rel="service-doc", </llms.txt>; rel="describedby"; type="text/plain", </legal>; rel="terms-of-service"`

Stop the dev server afterwards.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/lib/agent-discovery/link-header.ts \
        apps/web/src/lib/agent-discovery/link-header.test.ts \
        apps/web/src/lib/agent-discovery/endpoints.ts \
        apps/web/next.config.ts
git commit -m "feat(web): advertise agent discovery targets via RFC 8288 Link header"
```

---

### Task 2: Content Signals in robots.txt

**Files:**
- Modify: `apps/web/public/robots.txt`
- Create: `apps/web/src/lib/agent-discovery/robots-content-signal.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: nothing consumed by later tasks

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/lib/agent-discovery/robots-content-signal.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

const robots = fs.readFileSync(path.join(process.cwd(), 'public', 'robots.txt'), 'utf8');

describe('robots.txt content signals', () => {
  test('declares the Kortix stance: findable and citable, not trainable', () => {
    expect(robots).toContain('Content-Signal: search=yes, ai-input=yes, ai-train=no');
  });

  test('the directive sits inside the User-agent: * group', () => {
    const lines = robots.split('\n').map((line) => line.trim());
    const groupStart = lines.indexOf('User-agent: *');
    const signal = lines.findIndex((line) => line.startsWith('Content-Signal:'));
    expect(groupStart).toBeGreaterThanOrEqual(0);
    expect(signal).toBeGreaterThan(groupStart);

    // No other User-agent group may open between the two, or the signal would
    // bind to the wrong agent group.
    const between = lines.slice(groupStart + 1, signal);
    expect(between.some((line) => line.startsWith('User-agent:'))).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/lib/agent-discovery/robots-content-signal.test.ts`
Expected: FAIL — `expect(received).toContain(expected)`, the signal is absent.

- [ ] **Step 3: Add the directive**

In `apps/web/public/robots.txt`, replace these three lines:

```
User-agent: *
Allow: /
Allow: /api/ai
```

with:

```
# Content usage preferences (contentsignals.org). In prose: Kortix content may
# be indexed and cited, and may be used to ground AI answers, but may not be
# used to train models.
User-agent: *
Content-Signal: search=yes, ai-input=yes, ai-train=no
Allow: /
Allow: /api/ai
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test src/lib/agent-discovery/robots-content-signal.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/web/public/robots.txt \
        apps/web/src/lib/agent-discovery/robots-content-signal.test.ts
git commit -m "feat(web): declare AI content usage preferences via Content-Signal"
```

---

### Task 3: API catalog (RFC 9727)

**Files:**
- Create: `apps/web/src/lib/agent-discovery/api-catalog.ts`
- Create: `apps/web/src/lib/agent-discovery/api-catalog.test.ts`
- Create: `apps/web/src/app/(public)/well-known/api-catalog/route.ts`
- Modify: `apps/web/next.config.ts` (`rewrites()` at line 250)

**Interfaces:**
- Consumes: `API_BASE`, `OPENAPI_URL`, `API_HEALTH_URL`, `AGENT_INDEX_URL`, `siteUrl` from `./endpoints`; `DISCOVERY_PATHS` from `./link-header`; `MACHINE_CONTENT_CACHE_CONTROL` from `@/lib/seo/response`
- Produces: `buildApiCatalog(): { linkset: LinksetEntry[] }` where
  `type LinkTarget = { href: string; type?: string }` and
  `type LinksetEntry = { anchor: string } & Partial<Record<'service-desc' | 'service-doc' | 'status' | 'describedby' | 'terms-of-service', LinkTarget[]>>`

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/lib/agent-discovery/api-catalog.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';

import { GET } from '@/app/(public)/well-known/api-catalog/route';
import { API_BASE, AGENT_INDEX_URL, API_HEALTH_URL, OPENAPI_URL } from './endpoints';
import { buildApiCatalog } from './api-catalog';

describe('api catalog', () => {
  test('is a linkset with one entry per discoverable API', () => {
    const catalog = buildApiCatalog();
    expect(Array.isArray(catalog.linkset)).toBe(true);
    expect(catalog.linkset.map((entry) => entry.anchor)).toEqual([
      API_BASE,
      AGENT_INDEX_URL,
    ]);
  });

  test('the REST API entry points at the real spec, docs and health endpoint', () => {
    const [rest] = buildApiCatalog().linkset;
    expect(rest['service-desc']).toEqual([
      { href: OPENAPI_URL, type: 'application/json' },
    ]);
    expect(rest['service-doc']).toEqual([
      { href: 'https://kortix.com/docs', type: 'text/html' },
    ]);
    expect(rest.status).toEqual([{ href: API_HEALTH_URL, type: 'application/json' }]);
  });

  test('the content index entry points at the llms.txt family', () => {
    const [, content] = buildApiCatalog().linkset;
    expect(content.describedby).toEqual([
      { href: 'https://kortix.com/llms.txt', type: 'text/plain' },
      { href: 'https://kortix.com/llms-full.txt', type: 'text/plain' },
    ]);
  });

  test('every anchor and href is an absolute https URL', () => {
    for (const entry of buildApiCatalog().linkset) {
      expect(entry.anchor.startsWith('https://')).toBe(true);
      for (const [key, targets] of Object.entries(entry)) {
        if (key === 'anchor') continue;
        for (const target of targets as { href: string }[]) {
          expect(target.href.startsWith('https://')).toBe(true);
        }
      }
    }
  });

  test('the route serves application/linkset+json', async () => {
    const response = GET();
    expect(response.headers.get('content-type')).toBe('application/linkset+json');
    expect(await response.json()).toEqual(buildApiCatalog());
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/lib/agent-discovery/api-catalog.test.ts`
Expected: FAIL — `Cannot find module './api-catalog'`.

- [ ] **Step 3: Write the builder**

Create `apps/web/src/lib/agent-discovery/api-catalog.ts`:

```ts
import { DISCOVERY_PATHS } from './link-header';
import { AGENT_INDEX_URL, API_BASE, API_HEALTH_URL, OPENAPI_URL, siteUrl } from './endpoints';

type LinkTarget = { href: string; type?: string };

type LinksetEntry = { anchor: string } & Partial<
  Record<'service-desc' | 'service-doc' | 'status' | 'describedby' | 'terms-of-service', LinkTarget[]>
>;

/** RFC 9727 API catalog, serialised as an RFC 9264 linkset. */
export function buildApiCatalog(): { linkset: LinksetEntry[] } {
  return {
    linkset: [
      {
        anchor: API_BASE,
        'service-desc': [{ href: OPENAPI_URL, type: 'application/json' }],
        'service-doc': [{ href: siteUrl(DISCOVERY_PATHS.docs), type: 'text/html' }],
        status: [{ href: API_HEALTH_URL, type: 'application/json' }],
        'terms-of-service': [{ href: siteUrl(DISCOVERY_PATHS.terms) }],
      },
      {
        anchor: AGENT_INDEX_URL,
        'service-doc': [{ href: siteUrl(DISCOVERY_PATHS.docs), type: 'text/html' }],
        describedby: [
          { href: siteUrl(DISCOVERY_PATHS.llmsTxt), type: 'text/plain' },
          { href: siteUrl('/llms-full.txt'), type: 'text/plain' },
        ],
      },
    ],
  };
}
```

- [ ] **Step 4: Write the route handler**

Create `apps/web/src/app/(public)/well-known/api-catalog/route.ts`:

```ts
import { buildApiCatalog } from '@/lib/agent-discovery/api-catalog';
import { MACHINE_CONTENT_CACHE_CONTROL } from '@/lib/seo/response';

export const dynamic = 'force-static';
export const revalidate = 3600;

export function GET(): Response {
  return new Response(`${JSON.stringify(buildApiCatalog(), null, 2)}\n`, {
    headers: {
      'Cache-Control': MACHINE_CONTENT_CACHE_CONTROL,
      'Content-Type': 'application/linkset+json',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
```

- [ ] **Step 5: Add the rewrite**

In `apps/web/next.config.ts` `rewrites()` (line 250), add as the **first** element of the returned array:

```ts
      // Agent discovery documents. The App Router ignores dot-prefixed
      // directories, so the handlers live under `(public)/well-known/…` and are
      // surfaced at their spec-mandated paths here. These are `afterFiles`
      // rewrites (a bare array), so `public/` wins on collision — none of these
      // paths collide with the two existing files in public/.well-known/.
      {
        source: '/.well-known/api-catalog',
        destination: '/well-known/api-catalog',
      },
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `bun test src/lib/agent-discovery/api-catalog.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 7: Verify the rewrite end to end**

Run: `bun run dev &` then `curl -s -H 'Accept: application/linkset+json' http://localhost:3000/.well-known/api-catalog | head -20`
Expected: the linkset JSON, not a 404 page.

Stop the dev server afterwards.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/lib/agent-discovery/api-catalog.ts \
        apps/web/src/lib/agent-discovery/api-catalog.test.ts \
        "apps/web/src/app/(public)/well-known/api-catalog/route.ts" \
        apps/web/next.config.ts
git commit -m "feat(web): publish an RFC 9727 API catalog at /.well-known/api-catalog"
```

---

### Task 4: OAuth authorization server and protected resource metadata

Both documents come from one module so their endpoint URLs and scope lists cannot disagree.

**Files:**
- Create: `apps/web/src/lib/agent-discovery/oauth-metadata.ts`
- Create: `apps/web/src/lib/agent-discovery/oauth-metadata.test.ts`
- Create: `apps/web/src/app/(public)/well-known/oauth-authorization-server/route.ts`
- Create: `apps/web/src/app/(public)/well-known/oauth-protected-resource/route.ts`
- Modify: `apps/web/next.config.ts` (`rewrites()`)

**Interfaces:**
- Consumes: everything `OAUTH_*` plus `API_BASE`, `siteUrl` from `./endpoints`; `DISCOVERY_PATHS` from `./link-header`
- Produces:
  - `buildAuthorizationServerMetadata(): AuthorizationServerMetadata`
  - `buildProtectedResourceMetadata(): ProtectedResourceMetadata`

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/lib/agent-discovery/oauth-metadata.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';

import { GET as getAuthorizationServer } from '@/app/(public)/well-known/oauth-authorization-server/route';
import { GET as getProtectedResource } from '@/app/(public)/well-known/oauth-protected-resource/route';
import { API_BASE, OAUTH_ISSUER } from './endpoints';
import {
  buildAuthorizationServerMetadata,
  buildProtectedResourceMetadata,
} from './oauth-metadata';

describe('authorization server metadata', () => {
  test('carries every field RFC 8414 requires', () => {
    const metadata = buildAuthorizationServerMetadata();
    expect(metadata.issuer).toBe(OAUTH_ISSUER);
    expect(metadata.authorization_endpoint).toBe(
      'https://api.kortix.com/v1/oauth/authorize',
    );
    expect(metadata.token_endpoint).toBe('https://api.kortix.com/v1/oauth/token');
    expect(metadata.response_types_supported).toEqual(['code']);
  });

  test('describes the flow apps/api actually implements', () => {
    const metadata = buildAuthorizationServerMetadata();
    expect(metadata.grant_types_supported).toEqual([
      'authorization_code',
      'refresh_token',
    ]);
    expect(metadata.code_challenge_methods_supported).toEqual(['S256']);
    expect(metadata.token_endpoint_auth_methods_supported).toEqual([
      'client_secret_post',
    ]);
    expect(metadata.scopes_supported).toEqual(['profile']);
  });

  test('claims no OIDC capability, because Kortix issues opaque tokens', () => {
    const metadata = buildAuthorizationServerMetadata() as Record<string, unknown>;
    expect(metadata.jwks_uri).toBeUndefined();
    expect(metadata.id_token_signing_alg_values_supported).toBeUndefined();
    expect(metadata.subject_types_supported).toBeUndefined();
  });

  test('points agents at a real place to request credentials', () => {
    // There is no dynamic client registration endpoint in apps/api, so
    // register_uri must be the human request path, not an invented /register.
    const { agent_auth: agentAuth } = buildAuthorizationServerMetadata();
    expect(agentAuth.register_uri).toBe('https://kortix.com/contact');
    expect(agentAuth.credential_types).toEqual(['client_secret']);
  });

  test('the metadata document location derives from the issuer', () => {
    // RFC 8414 §3: issuer https://kortix.com => metadata at
    // https://kortix.com/.well-known/oauth-authorization-server.
    expect(OAUTH_ISSUER).toBe('https://kortix.com');
  });
});

describe('protected resource metadata', () => {
  test('names the resource and the authorization server that guards it', () => {
    const metadata = buildProtectedResourceMetadata();
    expect(metadata.resource).toBe(API_BASE);
    expect(metadata.authorization_servers).toEqual([OAUTH_ISSUER]);
  });

  test('declares bearer tokens in the Authorization header', () => {
    expect(buildProtectedResourceMetadata().bearer_methods_supported).toEqual([
      'header',
    ]);
  });

  test('advertises the same scopes as the authorization server', () => {
    expect(buildProtectedResourceMetadata().scopes_supported).toEqual(
      buildAuthorizationServerMetadata().scopes_supported,
    );
  });
});

describe('routes', () => {
  test('both serve application/json', async () => {
    const as = getAuthorizationServer();
    const pr = getProtectedResource();
    expect(as.headers.get('content-type')).toBe('application/json');
    expect(pr.headers.get('content-type')).toBe('application/json');
    expect(await as.json()).toEqual(buildAuthorizationServerMetadata());
    expect(await pr.json()).toEqual(buildProtectedResourceMetadata());
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/lib/agent-discovery/oauth-metadata.test.ts`
Expected: FAIL — `Cannot find module './oauth-metadata'`.

- [ ] **Step 3: Write the builder**

Create `apps/web/src/lib/agent-discovery/oauth-metadata.ts`:

```ts
import { DISCOVERY_PATHS } from './link-header';
import {
  API_BASE,
  OAUTH_CODE_CHALLENGE_METHODS,
  OAUTH_ENDPOINTS,
  OAUTH_GRANT_TYPES,
  OAUTH_ISSUER,
  OAUTH_RESPONSE_TYPES,
  OAUTH_SCOPES_SUPPORTED,
  OAUTH_TOKEN_AUTH_METHODS,
  siteUrl,
} from './endpoints';

type AgentAuth = {
  register_uri: string;
  identity_types: string[];
  credential_types: string[];
};

export type AuthorizationServerMetadata = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
  response_types_supported: string[];
  grant_types_supported: string[];
  code_challenge_methods_supported: string[];
  token_endpoint_auth_methods_supported: string[];
  scopes_supported: string[];
  service_documentation: string;
  agent_auth: AgentAuth;
};

export type ProtectedResourceMetadata = {
  resource: string;
  authorization_servers: string[];
  scopes_supported: string[];
  bearer_methods_supported: string[];
  resource_documentation: string;
};

/**
 * RFC 8414 metadata. Deliberately not an `openid-configuration`: Kortix issues
 * opaque database-backed tokens with no `id_token` and exposes no JWKS, so an
 * OIDC discovery document would advertise a flow that does not exist.
 */
export function buildAuthorizationServerMetadata(): AuthorizationServerMetadata {
  return {
    issuer: OAUTH_ISSUER,
    authorization_endpoint: OAUTH_ENDPOINTS.authorization,
    token_endpoint: OAUTH_ENDPOINTS.token,
    userinfo_endpoint: OAUTH_ENDPOINTS.userinfo,
    response_types_supported: [...OAUTH_RESPONSE_TYPES],
    grant_types_supported: [...OAUTH_GRANT_TYPES],
    code_challenge_methods_supported: [...OAUTH_CODE_CHALLENGE_METHODS],
    token_endpoint_auth_methods_supported: [...OAUTH_TOKEN_AUTH_METHODS],
    scopes_supported: [...OAUTH_SCOPES_SUPPORTED],
    service_documentation: siteUrl(DISCOVERY_PATHS.docs),
    agent_auth: {
      // No dynamic client registration exists in apps/api/src/oauth/index.ts;
      // clients are provisioned out of band. Pointing at a real request path
      // beats inventing a /register that would 404.
      register_uri: siteUrl('/contact'),
      identity_types: ['service_account'],
      credential_types: ['client_secret'],
    },
  };
}

/**
 * RFC 9728 metadata. Strictly this document derives from the resource
 * identifier and belongs at api.kortix.com/.well-known/oauth-protected-resource/v1;
 * serving it here is a discovery mirror. See the spec's follow-up list.
 */
export function buildProtectedResourceMetadata(): ProtectedResourceMetadata {
  return {
    resource: API_BASE,
    authorization_servers: [OAUTH_ISSUER],
    scopes_supported: [...OAUTH_SCOPES_SUPPORTED],
    bearer_methods_supported: ['header'],
    resource_documentation: siteUrl(DISCOVERY_PATHS.docs),
  };
}
```

- [ ] **Step 4: Write the two route handlers**

Create `apps/web/src/app/(public)/well-known/oauth-authorization-server/route.ts`:

```ts
import { buildAuthorizationServerMetadata } from '@/lib/agent-discovery/oauth-metadata';
import { MACHINE_CONTENT_CACHE_CONTROL } from '@/lib/seo/response';

export const dynamic = 'force-static';
export const revalidate = 3600;

export function GET(): Response {
  return new Response(
    `${JSON.stringify(buildAuthorizationServerMetadata(), null, 2)}\n`,
    {
      headers: {
        'Cache-Control': MACHINE_CONTENT_CACHE_CONTROL,
        'Content-Type': 'application/json',
        'X-Content-Type-Options': 'nosniff',
      },
    },
  );
}
```

Create `apps/web/src/app/(public)/well-known/oauth-protected-resource/route.ts`:

```ts
import { buildProtectedResourceMetadata } from '@/lib/agent-discovery/oauth-metadata';
import { MACHINE_CONTENT_CACHE_CONTROL } from '@/lib/seo/response';

export const dynamic = 'force-static';
export const revalidate = 3600;

export function GET(): Response {
  return new Response(
    `${JSON.stringify(buildProtectedResourceMetadata(), null, 2)}\n`,
    {
      headers: {
        'Cache-Control': MACHINE_CONTENT_CACHE_CONTROL,
        'Content-Type': 'application/json',
        'X-Content-Type-Options': 'nosniff',
      },
    },
  );
}
```

- [ ] **Step 5: Add the rewrites**

In `apps/web/next.config.ts` `rewrites()`, directly after the `api-catalog` entry from Task 3:

```ts
      {
        source: '/.well-known/oauth-authorization-server',
        destination: '/well-known/oauth-authorization-server',
      },
      {
        source: '/.well-known/oauth-protected-resource',
        destination: '/well-known/oauth-protected-resource',
      },
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `bun test src/lib/agent-discovery/oauth-metadata.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/lib/agent-discovery/oauth-metadata.ts \
        apps/web/src/lib/agent-discovery/oauth-metadata.test.ts \
        "apps/web/src/app/(public)/well-known/oauth-authorization-server/route.ts" \
        "apps/web/src/app/(public)/well-known/oauth-protected-resource/route.ts" \
        apps/web/next.config.ts
git commit -m "feat(web): publish OAuth authorization server and protected resource metadata"
```

---

### Task 5: auth.md

**Files:**
- Create: `apps/web/src/lib/agent-discovery/auth-md.ts`
- Create: `apps/web/src/lib/agent-discovery/auth-md.test.ts`
- Create: `apps/web/src/app/auth.md/route.ts`

`/auth.md` needs no rewrite — the directory name carries the dot, exactly as `src/app/llms.txt/route.ts` already does. It is already unauthenticated: middleware's `PUBLIC_ROUTES` contains `/auth` and matches with `startsWith`.

**Interfaces:**
- Consumes: `OAUTH_*`, `API_BASE`, `siteUrl` from `./endpoints`; `DISCOVERY_PATHS` from `./link-header`
- Produces: `renderAuthMd(): string`

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/lib/agent-discovery/auth-md.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';

import { GET } from '@/app/auth.md/route';
import { OAUTH_ENDPOINTS, OAUTH_TOKEN_RATE_LIMIT_PER_MINUTE } from './endpoints';
import { renderAuthMd } from './auth-md';
import { buildAuthorizationServerMetadata } from './oauth-metadata';

const body = renderAuthMd();

describe('auth.md', () => {
  test('lists every OAuth endpoint the API exposes', () => {
    expect(body).toContain(OAUTH_ENDPOINTS.authorization);
    expect(body).toContain(OAUTH_ENDPOINTS.token);
    expect(body).toContain(OAUTH_ENDPOINTS.userinfo);
  });

  test('states that PKCE is mandatory and S256 is the only method', () => {
    expect(body).toContain('PKCE');
    expect(body).toContain('S256');
  });

  test('is honest that there is no self-service registration', () => {
    expect(body).toContain('no dynamic client registration');
    expect(body).toContain(buildAuthorizationServerMetadata().agent_auth.register_uri);
  });

  test('documents the token endpoint rate limit', () => {
    expect(body).toContain(String(OAUTH_TOKEN_RATE_LIMIT_PER_MINUTE));
  });

  test('links the machine-readable companions', () => {
    expect(body).toContain('/.well-known/oauth-authorization-server');
    expect(body).toContain('/.well-known/oauth-protected-resource');
    expect(body).toContain('/.well-known/api-catalog');
  });

  test('never claims an OIDC capability Kortix does not have', () => {
    expect(body).not.toContain('id_token');
    expect(body).not.toContain('jwks');
  });

  test('the route serves markdown', async () => {
    const response = GET();
    expect(response.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    expect(await response.text()).toBe(body);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/lib/agent-discovery/auth-md.test.ts`
Expected: FAIL — `Cannot find module './auth-md'`.

- [ ] **Step 3: Write the renderer**

Create `apps/web/src/lib/agent-discovery/auth-md.ts`:

```ts
import { DISCOVERY_PATHS } from './link-header';
import {
  API_BASE,
  OAUTH_ENDPOINTS,
  OAUTH_ISSUER,
  OAUTH_SCOPES_SUPPORTED,
  OAUTH_TOKEN_RATE_LIMIT_PER_MINUTE,
  siteUrl,
} from './endpoints';

/**
 * Agent registration instructions (workos.com/auth-md). Everything here is
 * derived from the same constants as the two well-known OAuth documents, so
 * the three cannot drift apart.
 */
export function renderAuthMd(): string {
  return `# Authenticating agents with Kortix

Kortix exposes a REST API at ${API_BASE}. Access is granted through an
OAuth 2.0 authorization code flow with mandatory PKCE.

## Endpoints

| Purpose | URL |
| --- | --- |
| Authorization | ${OAUTH_ENDPOINTS.authorization} |
| Token | ${OAUTH_ENDPOINTS.token} |
| User info | ${OAUTH_ENDPOINTS.userinfo} |

Issuer: ${OAUTH_ISSUER}

## Flow

1. Redirect the user to the authorization endpoint with \`response_type=code\`,
   your \`client_id\`, a registered \`redirect_uri\`, the scopes you need, and a
   \`code_challenge\`.
2. PKCE is required. \`code_challenge_method=S256\` is the only accepted method;
   a request without a challenge is rejected with \`invalid_request\`.
3. Exchange the returned code at the token endpoint. Send \`client_id\` and
   \`client_secret\` in the form body (\`client_secret_post\`).
4. Call the API with \`Authorization: Bearer <access_token>\`.
5. Refresh with \`grant_type=refresh_token\` when the access token expires.

The token endpoint is rate limited to ${OAUTH_TOKEN_RATE_LIMIT_PER_MINUTE}
requests per minute per client.

## Scopes

${OAUTH_SCOPES_SUPPORTED.map((scope) => `- \`${scope}\``).join('\n')}

## Getting credentials

Kortix has **no dynamic client registration** endpoint. OAuth clients are
provisioned by the Kortix team rather than self-service, so an agent cannot mint
its own credentials. Request a client at ${siteUrl('/contact')} and include the
redirect URIs and scopes you need.

## Machine-readable companions

- ${siteUrl(DISCOVERY_PATHS.authorizationServer)}
- ${siteUrl(DISCOVERY_PATHS.protectedResource)}
- ${siteUrl(DISCOVERY_PATHS.apiCatalog)}
- ${siteUrl(DISCOVERY_PATHS.llmsTxt)}
`;
}
```

- [ ] **Step 4: Write the route handler**

Create `apps/web/src/app/auth.md/route.ts`:

```ts
import { renderAuthMd } from '@/lib/agent-discovery/auth-md';
import { MACHINE_CONTENT_CACHE_CONTROL } from '@/lib/seo/response';

export const dynamic = 'force-static';
export const revalidate = 3600;

export function GET(): Response {
  return new Response(renderAuthMd(), {
    headers: {
      'Cache-Control': MACHINE_CONTENT_CACHE_CONTROL,
      'Content-Disposition': 'inline',
      'Content-Type': 'text/markdown; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'X-Robots-Tag': 'index, follow',
    },
  });
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test src/lib/agent-discovery/auth-md.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 6: Verify it is reachable without authentication**

Run: `bun run dev &` then `curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/auth.md`
Expected: `200` (not `307` to `/auth`).

Stop the dev server afterwards.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/lib/agent-discovery/auth-md.ts \
        apps/web/src/lib/agent-discovery/auth-md.test.ts \
        apps/web/src/app/auth.md/route.ts
git commit -m "feat(web): publish auth.md with agent registration instructions"
```

---

### Task 6: Agent skills discovery index

Three outward-facing skills. The repository's existing `.claude/skills/` are internal engineering workflow and are **not** published.

Digests are computed at request time from the exact bytes the sibling route serves, so no committed hash can drift. This runs in a route handler on the Node runtime, where `node:fs` is available — the Edge constraint does not apply here.

**Files:**
- Create: `apps/web/src/content/agent-skills/kortix-api/SKILL.md`
- Create: `apps/web/src/content/agent-skills/kortix-sdk/SKILL.md`
- Create: `apps/web/src/content/agent-skills/kortix-agent-content/SKILL.md`
- Create: `apps/web/src/lib/agent-discovery/skills.ts`
- Create: `apps/web/src/lib/agent-discovery/skills.test.ts`
- Create: `apps/web/src/app/(public)/well-known/agent-skills/index.json/route.ts`
- Create: `apps/web/src/app/(public)/well-known/agent-skills/[name]/SKILL.md/route.ts`
- Modify: `apps/web/next.config.ts` (`rewrites()`)

**Interfaces:**
- Consumes: `siteUrl` from `./endpoints`
- Produces:
  - `AGENT_SKILLS: readonly { name: string; description: string }[]`
  - `readSkillBody(name: string): string | null`
  - `buildSkillsIndex(): { $schema: string; skills: { name: string; type: 'skill'; description: string; url: string; sha256: string }[] }`

- [ ] **Step 1: Write the three skill files**

Create `apps/web/src/content/agent-skills/kortix-api/SKILL.md`:

```markdown
---
name: kortix-api
description: Authenticate against and call the Kortix REST API at api.kortix.com/v1.
---

# Calling the Kortix API

Kortix exposes a REST API at `https://api.kortix.com/v1`. The full machine-readable
contract is the OpenAPI document at `https://api.kortix.com/v1/openapi.json`;
browsable reference docs are at `https://api.kortix.com/v1/docs`.

## Before you start

Fetch the OpenAPI document and work from it. It is the source of truth for every
path, parameter, and response shape. Do not guess endpoint names.

## Authenticating

Kortix uses OAuth 2.0 authorization code flow with mandatory PKCE (`S256`).

1. Read `https://kortix.com/.well-known/oauth-authorization-server` for the
   current endpoint URLs.
2. Redirect the user to the authorization endpoint with `response_type=code`,
   your `client_id`, your `redirect_uri`, the scopes you need, and a
   `code_challenge`.
3. Exchange the code at the token endpoint, sending `client_id` and
   `client_secret` in the form body.
4. Send `Authorization: Bearer <access_token>` on every API call.

Credentials are provisioned by the Kortix team, not self-service. See
`https://kortix.com/auth.md`.

## Checking availability

`GET https://api.kortix.com/v1/health` returns the service status. Use it before
a long run rather than discovering an outage mid-task.

## Rate limits

The token endpoint allows 20 requests per minute per client. Cache access tokens
and refresh them rather than re-running the authorization flow.
```

Create `apps/web/src/content/agent-skills/kortix-sdk/SKILL.md`:

```markdown
---
name: kortix-sdk
description: Install and use the @kortix/sdk TypeScript client instead of hand-rolling HTTP calls.
---

# Using the Kortix TypeScript SDK

`@kortix/sdk` is the first-party TypeScript client for the Kortix API. Prefer it
over hand-written `fetch` calls: it carries the request shapes, handles token
refresh, and stays in step with the API.

## Install

```bash
npm install @kortix/sdk
```

## Configure

The SDK is framework-free. It works in plain JavaScript, in Node, and in the
browser; the React bindings are an optional layer, not a requirement.

```ts
import { configureKortix } from '@kortix/sdk';

configureKortix({
  backendUrl: 'https://api.kortix.com/v1',
  getToken: async () => currentAccessToken,
});
```

`getToken` is called before each request, so return a fresh token from your own
refresh logic rather than a captured constant.

## When to use the raw API instead

If you need an endpoint the SDK does not yet wrap, read
`https://api.kortix.com/v1/openapi.json` and call it directly with the same
bearer token. See the `kortix-api` skill.
```

Create `apps/web/src/content/agent-skills/kortix-agent-content/SKILL.md`:

```markdown
---
name: kortix-agent-content
description: Read kortix.com content as markdown instead of scraping HTML.
---

# Reading Kortix content as markdown

Every public page on kortix.com has a markdown representation. Use it. Parsing
the HTML wastes context on layout markup and breaks when the site is restyled.

## Three ways in, cheapest first

**Content negotiation.** Request any public page with `Accept: text/markdown`
and you get markdown back:

```bash
curl -H 'Accept: text/markdown' https://kortix.com/pricing
```

The response carries `Content-Type: text/markdown` and an `x-markdown-tokens`
header estimating its size, so you can budget context before reading. HTML
remains the default for browsers.

**Direct markdown paths.** Every page also has a stable twin under `/markdown/`,
advertised on the HTML response as `Link: <…>; rel="alternate"; type="text/markdown"`.

**Site index.** `https://kortix.com/llms.txt` is a short map of the site.
`https://kortix.com/llms-full.txt` is the long form. For a paginated,
machine-friendly listing with per-record `last_modified` timestamps, use
`https://kortix.com/api/ai`.

## Freshness

Records in `/api/ai` carry `last_modified`. Prefer recent content when answering
questions about pricing, product capabilities, or availability.

## Usage terms

`https://kortix.com/robots.txt` declares `Content-Signal: search=yes,
ai-input=yes, ai-train=no`. Indexing and grounding answers is welcome; training
models on this content is not.
```

- [ ] **Step 2: Write the failing test**

Create `apps/web/src/lib/agent-discovery/skills.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';

import { GET as getIndex } from '@/app/(public)/well-known/agent-skills/index.json/route';
import { GET as getSkill } from '@/app/(public)/well-known/agent-skills/[name]/SKILL.md/route';
import { AGENT_SKILLS, buildSkillsIndex, readSkillBody } from './skills';

describe('agent skills index', () => {
  test('publishes the three outward-facing skills', () => {
    expect(AGENT_SKILLS.map((skill) => skill.name)).toEqual([
      'kortix-api',
      'kortix-sdk',
      'kortix-agent-content',
    ]);
  });

  test('every entry resolves to a readable SKILL.md', () => {
    for (const skill of AGENT_SKILLS) {
      expect(readSkillBody(skill.name)).toBeTruthy();
    }
  });

  test('the digest matches the bytes the sibling route serves', async () => {
    for (const entry of buildSkillsIndex().skills) {
      const response = await getSkill(new Request('https://kortix.com'), {
        params: Promise.resolve({ name: entry.name }),
      });
      const served = await response.text();
      expect(createHash('sha256').update(served, 'utf8').digest('hex')).toBe(
        entry.sha256,
      );
    }
  });

  test('every url is absolute and points at this origin', () => {
    for (const entry of buildSkillsIndex().skills) {
      expect(entry.url).toBe(
        `https://kortix.com/.well-known/agent-skills/${entry.name}/SKILL.md`,
      );
    }
  });

  test('declares the discovery RFC schema and the skill type', () => {
    const index = buildSkillsIndex();
    expect(index.$schema).toBe('https://agentskills.io/schemas/v0.2.0/index.json');
    for (const entry of index.skills) {
      expect(entry.type).toBe('skill');
      expect(entry.description.length).toBeGreaterThan(0);
    }
  });

  test('an unknown skill name is a 404, not a path traversal', async () => {
    const response = await getSkill(new Request('https://kortix.com'), {
      params: Promise.resolve({ name: '../../../../etc/passwd' }),
    });
    expect(response.status).toBe(404);
  });

  test('the index route serves application/json', async () => {
    const response = getIndex();
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual(buildSkillsIndex());
  });

  test('a skill route serves markdown', async () => {
    const response = await getSkill(new Request('https://kortix.com'), {
      params: Promise.resolve({ name: 'kortix-api' }),
    });
    expect(response.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `bun test src/lib/agent-discovery/skills.test.ts`
Expected: FAIL — `Cannot find module './skills'`.

- [ ] **Step 4: Write the skills module**

Create `apps/web/src/lib/agent-discovery/skills.ts`:

```ts
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { siteUrl } from './endpoints';

export const AGENT_SKILLS = [
  {
    name: 'kortix-api',
    description: 'Authenticate against and call the Kortix REST API at api.kortix.com/v1.',
  },
  {
    name: 'kortix-sdk',
    description:
      'Install and use the @kortix/sdk TypeScript client instead of hand-rolling HTTP calls.',
  },
  {
    name: 'kortix-agent-content',
    description: 'Read kortix.com content as markdown instead of scraping HTML.',
  },
] as const;

const SKILLS_ROOT = () => path.join(process.cwd(), 'src', 'content', 'agent-skills');

function isPublishedSkill(name: string): boolean {
  return AGENT_SKILLS.some((skill) => skill.name === name);
}

/**
 * Reads a published skill body. The allowlist check is the traversal guard —
 * `name` arrives from a dynamic route segment, so it must never reach
 * path.join unvalidated.
 */
export function readSkillBody(name: string): string | null {
  if (!isPublishedSkill(name)) return null;
  try {
    return fs.readFileSync(path.join(SKILLS_ROOT(), name, 'SKILL.md'), 'utf8');
  } catch {
    return null;
  }
}

export function skillUrl(name: string): string {
  return siteUrl(`/.well-known/agent-skills/${name}/SKILL.md`);
}

/**
 * Agent Skills Discovery RFC v0.2.0. Digests are computed from the same bytes
 * the SKILL.md route serves, so the index cannot go stale against its content.
 */
export function buildSkillsIndex(): {
  $schema: string;
  skills: { name: string; type: 'skill'; description: string; url: string; sha256: string }[];
} {
  return {
    $schema: 'https://agentskills.io/schemas/v0.2.0/index.json',
    skills: AGENT_SKILLS.flatMap((skill) => {
      const body = readSkillBody(skill.name);
      if (body === null) return [];
      return [
        {
          name: skill.name,
          type: 'skill' as const,
          description: skill.description,
          url: skillUrl(skill.name),
          sha256: createHash('sha256').update(body, 'utf8').digest('hex'),
        },
      ];
    }),
  };
}
```

- [ ] **Step 5: Write the two route handlers**

Create `apps/web/src/app/(public)/well-known/agent-skills/index.json/route.ts`:

```ts
import { buildSkillsIndex } from '@/lib/agent-discovery/skills';
import { MACHINE_CONTENT_CACHE_CONTROL } from '@/lib/seo/response';

export const dynamic = 'force-static';
export const revalidate = 3600;

export function GET(): Response {
  return new Response(`${JSON.stringify(buildSkillsIndex(), null, 2)}\n`, {
    headers: {
      'Cache-Control': MACHINE_CONTENT_CACHE_CONTROL,
      'Content-Type': 'application/json',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
```

Create `apps/web/src/app/(public)/well-known/agent-skills/[name]/SKILL.md/route.ts`:

```ts
import { AGENT_SKILLS, readSkillBody } from '@/lib/agent-discovery/skills';
import { MACHINE_CONTENT_CACHE_CONTROL } from '@/lib/seo/response';

export const dynamic = 'force-static';
export const revalidate = 3600;

export function generateStaticParams(): { name: string }[] {
  return AGENT_SKILLS.map((skill) => ({ name: skill.name }));
}

export async function GET(
  _: Request,
  context: { params: Promise<{ name: string }> },
): Promise<Response> {
  const { name } = await context.params;
  const body = readSkillBody(name);
  if (body === null) return new Response('Not found\n', { status: 404 });

  return new Response(body, {
    headers: {
      'Cache-Control': MACHINE_CONTENT_CACHE_CONTROL,
      'Content-Disposition': 'inline',
      'Content-Type': 'text/markdown; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'X-Robots-Tag': 'index, follow',
    },
  });
}
```

- [ ] **Step 6: Add the rewrites**

In `apps/web/next.config.ts` `rewrites()`, after the OAuth entries from Task 4. The exact `index.json` source must come **first**, or the `:name` pattern would swallow it:

```ts
      {
        source: '/.well-known/agent-skills/index.json',
        destination: '/well-known/agent-skills/index.json',
      },
      {
        source: '/.well-known/agent-skills/:name/SKILL.md',
        destination: '/well-known/agent-skills/:name/SKILL.md',
      },
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `bun test src/lib/agent-discovery/skills.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/content/agent-skills \
        apps/web/src/lib/agent-discovery/skills.ts \
        apps/web/src/lib/agent-discovery/skills.test.ts \
        "apps/web/src/app/(public)/well-known/agent-skills" \
        apps/web/next.config.ts
git commit -m "feat(web): publish an agent skills discovery index"
```

---

### Task 7: Generated markdown route map

Middleware runs on the Edge runtime and cannot import `src/lib/seo/public-content.ts`, which uses `node:fs` to scan MDX sources. The route map must therefore reach middleware as plain data.

**Refinement of spec §2:** the spec proposed a `.mjs` script wired into `next.config.ts`. A bun script plus a drift test is better here: bun resolves the `@/` alias and can import `public-content.ts` directly, so there is no second copy of the record-to-path mapping to keep in sync — the exact duplication problem `build-content-timestamps.mjs` documents in its own header comment. The generated file is committed and CI catches drift.

**Files:**
- Create: `apps/web/scripts/build-markdown-routes.ts`
- Create: `apps/web/src/lib/seo/markdown-routes.json` (generated, committed)
- Create: `apps/web/src/lib/seo/markdown-routes.test.ts`
- Modify: `apps/web/package.json` (add the `markdown-routes:build` script)

**Interfaces:**
- Consumes: `getPublicContentRecords` from `@/lib/seo/public-content`
- Produces: `src/lib/seo/markdown-routes.json`, an object mapping `htmlPath` → `markdownPath`

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/lib/seo/markdown-routes.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';

import markdownRoutes from './markdown-routes.json';
import { getPublicContentRecords } from './public-content';

// Use-cases are excluded on purpose: `areUseCasesPublic()` reads an env var at
// runtime, and a committed static map cannot track that. Their markdown stays
// reachable at /markdown/use-cases/*.md; only Accept negotiation skips them.
function expectedRoutes(): Record<string, string> {
  const routes: Record<string, string> = {};
  for (const record of getPublicContentRecords({ includeUseCases: false })) {
    if (record.markdownPath) routes[record.htmlPath] = record.markdownPath;
  }
  return routes;
}

describe('markdown route map', () => {
  test('the committed map matches the current content records', () => {
    // Regenerate with: bun run markdown-routes:build
    expect(markdownRoutes).toEqual(expectedRoutes());
  });

  test('is not empty', () => {
    expect(Object.keys(markdownRoutes).length).toBeGreaterThan(0);
  });

  test('every key is a root-relative html path and every value a markdown path', () => {
    for (const [htmlPath, markdownPath] of Object.entries(markdownRoutes)) {
      expect(htmlPath.startsWith('/')).toBe(true);
      expect(markdownPath.startsWith('/markdown/')).toBe(true);
      expect(markdownPath.endsWith('.md')).toBe(true);
    }
  });

  test('maps the homepage and pricing, the two pages agents ask for most', () => {
    expect(markdownRoutes['/']).toBe('/markdown/index.md');
    expect(markdownRoutes['/pricing']).toBe('/markdown/pricing.md');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/lib/seo/markdown-routes.test.ts`
Expected: FAIL — `Cannot find module './markdown-routes.json'`.

- [ ] **Step 3: Write the generator**

Create `apps/web/scripts/build-markdown-routes.ts`:

```ts
/**
 * Generates src/lib/seo/markdown-routes.json — the htmlPath -> markdownPath map
 * that middleware uses for `Accept: text/markdown` negotiation.
 *
 * Middleware runs on the Edge runtime and cannot import public-content.ts,
 * which reads MDX sources with node:fs. Rather than reimplement the mapping in
 * an Edge-safe module (a second copy that would drift), the map is generated
 * here, committed, and pinned by src/lib/seo/markdown-routes.test.ts.
 *
 * Run with: bun run markdown-routes:build
 */
import fs from 'node:fs';
import path from 'node:path';

import { getPublicContentRecords } from '../src/lib/seo/public-content';

const OUTPUT = path.join(import.meta.dir, '..', 'src', 'lib', 'seo', 'markdown-routes.json');

// includeUseCases: false — areUseCasesPublic() reads an env var at runtime, and
// a committed static map cannot track that. Use-case markdown stays reachable
// at its direct /markdown/use-cases/*.md path.
const routes: Record<string, string> = {};
for (const record of getPublicContentRecords({ includeUseCases: false })) {
  if (record.markdownPath) routes[record.htmlPath] = record.markdownPath;
}

const sorted = Object.fromEntries(Object.entries(routes).sort(([a], [b]) => a.localeCompare(b)));
fs.writeFileSync(OUTPUT, `${JSON.stringify(sorted, null, 2)}\n`);
console.log(`Wrote ${Object.keys(sorted).length} markdown routes to ${OUTPUT}`);
```

- [ ] **Step 4: Add the package script**

In `apps/web/package.json`, add to `scripts`, directly after the `catalog:enrich` line:

```json
    "markdown-routes:build": "bun scripts/build-markdown-routes.ts",
```

- [ ] **Step 5: Generate the map**

Run: `bun run markdown-routes:build`
Expected: `Wrote <N> markdown routes to …/src/lib/seo/markdown-routes.json` with N greater than 20.

- [ ] **Step 6: Run the test to verify it passes**

Run: `bun test src/lib/seo/markdown-routes.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 7: Commit**

```bash
git add apps/web/scripts/build-markdown-routes.ts \
        apps/web/src/lib/seo/markdown-routes.json \
        apps/web/src/lib/seo/markdown-routes.test.ts \
        apps/web/package.json
git commit -m "feat(web): generate the html-to-markdown route map for agent negotiation"
```

---

### Task 8: Markdown content negotiation

**Files:**
- Create: `apps/web/src/lib/agent-discovery/markdown-negotiation.ts`
- Create: `apps/web/src/lib/agent-discovery/markdown-negotiation.test.ts`
- Modify: `apps/web/src/lib/seo/response.ts`
- Modify: `apps/web/src/lib/seo/coverage-manifest.ts`
- Modify: `apps/web/src/lib/seo/public-content.test.ts`
- Modify: `apps/web/src/middleware.ts`
- Modify: `apps/web/next.config.ts` (`headers()`)

**Interfaces:**
- Consumes: `markdown-routes.json` from Task 7; `markdownAlternateLinkValue` from `./link-header`
- Produces:
  - `prefersMarkdown(accept: string | null | undefined): boolean`
  - `markdownRouteFor(pathname: string): string | undefined`
  - `MARKDOWN_ROUTE_PATHS: string[]`

- [ ] **Step 1: Write the failing negotiation test**

Create `apps/web/src/lib/agent-discovery/markdown-negotiation.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';

import {
  MARKDOWN_ROUTE_PATHS,
  markdownRouteFor,
  prefersMarkdown,
} from './markdown-negotiation';

describe('prefersMarkdown', () => {
  test('a bare markdown request wants markdown', () => {
    expect(prefersMarkdown('text/markdown')).toBe(true);
  });

  test('an explicit q-value preference wants markdown', () => {
    expect(prefersMarkdown('text/markdown;q=1.0, text/html;q=0.8')).toBe(true);
  });

  test('a real browser Accept header still gets HTML', () => {
    expect(
      prefersMarkdown(
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      ),
    ).toBe(false);
  });

  test('markdown ranked below html gets HTML', () => {
    expect(prefersMarkdown('text/html, text/markdown;q=0.5')).toBe(false);
  });

  test('curl default */* gets HTML, because HTML is the default representation', () => {
    expect(prefersMarkdown('*/*')).toBe(false);
  });

  test('text/* does not tip the balance either way, so HTML wins', () => {
    expect(prefersMarkdown('text/*')).toBe(false);
  });

  test('a missing or empty header gets HTML', () => {
    expect(prefersMarkdown(null)).toBe(false);
    expect(prefersMarkdown(undefined)).toBe(false);
    expect(prefersMarkdown('')).toBe(false);
  });

  test('q=0 on markdown is a refusal, not a preference', () => {
    expect(prefersMarkdown('text/markdown;q=0, text/html;q=0')).toBe(false);
  });

  test('whitespace and casing are tolerated', () => {
    expect(prefersMarkdown('  TEXT/MARKDOWN ;  q=0.9 , text/html;q=0.1')).toBe(true);
  });
});

describe('markdownRouteFor', () => {
  test('resolves a known public page', () => {
    expect(markdownRouteFor('/pricing')).toBe('/markdown/pricing.md');
  });

  test('resolves the homepage', () => {
    expect(markdownRouteFor('/')).toBe('/markdown/index.md');
  });

  test('an unknown path has no markdown twin', () => {
    expect(markdownRouteFor('/projects/abc123')).toBeUndefined();
  });

  test('never resolves an authenticated route', () => {
    expect(markdownRouteFor('/dashboard')).toBeUndefined();
    expect(markdownRouteFor('/settings')).toBeUndefined();
  });

  test('the exported path list matches the map keys', () => {
    expect(MARKDOWN_ROUTE_PATHS).toContain('/pricing');
    expect(MARKDOWN_ROUTE_PATHS.every((path) => path.startsWith('/'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/lib/agent-discovery/markdown-negotiation.test.ts`
Expected: FAIL — `Cannot find module './markdown-negotiation'`.

- [ ] **Step 3: Write the negotiation module**

Create `apps/web/src/lib/agent-discovery/markdown-negotiation.ts`:

```ts
import markdownRoutes from '@/lib/seo/markdown-routes.json';

/**
 * Edge-safe: this module is imported by middleware and must never transitively
 * reach node:fs. That is why it reads the generated JSON map rather than
 * `@/lib/seo/public-content`.
 */
const ROUTES = markdownRoutes as Record<string, string>;

export const MARKDOWN_ROUTE_PATHS: string[] = Object.keys(ROUTES);

export function markdownRouteFor(pathname: string): string | undefined {
  return ROUTES[pathname];
}

type MediaRange = { type: string; q: number };

function parseAccept(header: string): MediaRange[] {
  return header
    .split(',')
    .map((part) => {
      const [rawType, ...params] = part.split(';').map((segment) => segment.trim());
      if (!rawType) return null;
      const qParam = params.find((param) => param.toLowerCase().startsWith('q='));
      const q = qParam ? Number.parseFloat(qParam.slice(2)) : 1;
      return { type: rawType.toLowerCase(), q: Number.isFinite(q) ? q : 0 };
    })
    .filter((range): range is MediaRange => range !== null);
}

function qualityFor(ranges: MediaRange[], mediaType: string): number {
  const group = mediaType.split('/')[0];
  let best = 0;
  for (const range of ranges) {
    if (range.type === mediaType || range.type === `${group}/*` || range.type === '*/*') {
      best = Math.max(best, range.q);
    }
  }
  return best;
}

/**
 * True only when the client ranks markdown strictly above HTML. A wildcard
 * (`*\/*` from curl, or a browser's `*\/*;q=0.8` tail) matches both equally and
 * therefore keeps HTML — HTML stays the default representation.
 */
export function prefersMarkdown(accept: string | null | undefined): boolean {
  if (!accept) return false;
  const ranges = parseAccept(accept);
  const markdown = qualityFor(ranges, 'text/markdown');
  if (markdown <= 0) return false;
  return markdown > qualityFor(ranges, 'text/html');
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test src/lib/agent-discovery/markdown-negotiation.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 5: Update the markdown response headers**

Replace the whole of `apps/web/src/lib/seo/response.ts` with:

```ts
import type { PublicContentRecord } from '@/lib/seo/public-content';
import { absoluteUrl } from '@/lib/seo/public-content';

export const MACHINE_CONTENT_CACHE_CONTROL =
  'public, max-age=0, s-maxage=3600, stale-while-revalidate=86400';

/**
 * A context-budget hint for agents, not an exact count. Real tokenisation is
 * model-specific; shipping a tokeniser to compute an advisory header is not
 * worth the bundle cost.
 */
export function estimateMarkdownTokens(markdown: string): number {
  return Math.ceil(markdown.length / 4);
}

export function markdownResponse(markdown: string, record: PublicContentRecord): Response {
  return new Response(markdown, {
    headers: {
      'Cache-Control': MACHINE_CONTENT_CACHE_CONTROL,
      'Content-Disposition': 'inline',
      'Content-Type': 'text/markdown; charset=utf-8',
      Link: `<${absoluteUrl(record.htmlPath)}>; rel="canonical"; type="text/html"`,
      // This body is reachable both directly and by negotiating on the HTML
      // path, so caches must key on Accept.
      Vary: 'Accept',
      'X-Content-Type-Options': 'nosniff',
      'X-Robots-Tag': 'index, follow',
      'x-markdown-tokens': String(estimateMarkdownTokens(markdown)),
    },
  });
}
```

- [ ] **Step 6: Update the coverage contract**

In `apps/web/src/lib/seo/coverage-manifest.ts`, change the `requiredMarkdownHeaders` block to:

```ts
  requiredMarkdownHeaders: {
    'Content-Type': 'text/markdown; charset=utf-8',
    'Content-Disposition': 'inline',
    'X-Robots-Tag': 'index, follow',
    Vary: 'Accept',
  },
```

- [ ] **Step 7: Run the existing SEO suite and fix what the change broke**

Run: `bun test src/lib/seo/public-content.test.ts`
Expected: FAIL on any assertion still pinning `text/plain; charset=utf-8` for markdown responses.

Update those assertions in `apps/web/src/lib/seo/public-content.test.ts` to expect
`text/markdown; charset=utf-8`. Leave the `llms.txt` and `llms-full.txt`
assertions alone — those routes stay `text/plain` because they are plain-text
site maps, not markdown documents.

Then add this test to the same file, inside the describe block covering markdown
responses:

```ts
  test('markdown responses carry a token-budget hint', () => {
    const record = getPublicContentRecords()[0];
    const response = markdownResponse('# Title\n\nBody text.\n', record);
    expect(Number(response.headers.get('x-markdown-tokens'))).toBeGreaterThan(0);
  });
```

Run: `bun test src/lib/seo/public-content.test.ts`
Expected: PASS.

- [ ] **Step 8: Add the middleware negotiation branch**

In `apps/web/src/middleware.ts`, add to the imports:

```ts
import {
  markdownRouteFor,
  prefersMarkdown,
} from '@/lib/agent-discovery/markdown-negotiation';
```

Then insert this as the **first** statement inside the middleware function body,
before the maintenance and locale logic:

```ts
  // Agents asking for markdown get the markdown twin of a public page. Only
  // paths in the generated route map qualify, all of which are public content,
  // so this can never expose an authenticated page. Browsers rank text/html
  // at least as high as text/markdown and fall through to HTML.
  const markdownPath = markdownRouteFor(request.nextUrl.pathname);
  if (markdownPath && prefersMarkdown(request.headers.get('accept'))) {
    return NextResponse.rewrite(new URL(markdownPath, request.url));
  }
```

- [ ] **Step 9: Add per-path Vary and alternate Link headers**

The HTML response on a negotiable path must also carry `Vary: Accept`, or a CDN
can cache HTML without an `Accept` key and serve it to an agent asking for
markdown. Middleware cannot do this — the HTML branch must fall through to the
locale and maintenance logic — so it is declared in `next.config.ts` instead,
scoped to exactly the negotiable paths rather than site-wide.

In `apps/web/next.config.ts`, widen the Task 1 import to bring in the helper:

```ts
import {
  SITE_LINK_HEADER,
  markdownAlternateLinkValue,
} from './src/lib/agent-discovery/link-header';
```

Then add, near the top after the existing imports (`__dirname` is available here
— `next.config.ts` already uses it at lines 72 and 147):

```ts
const MARKDOWN_ROUTES: Record<string, string> = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'src', 'lib', 'seo', 'markdown-routes.json'), 'utf8'),
);
```

Then in `headers()`, append this **after** the site-wide `Link` entry from Task 1
so it wins the override for these paths, carrying both the site links and the
page's own alternate:

```ts
      // Negotiable public pages. `Vary: Accept` is scoped to exactly these
      // paths — setting it site-wide would fragment every CDN cache entry by
      // request header. The Link value repeats SITE_LINK_HEADER because a later
      // matching entry replaces the earlier one rather than appending to it.
      ...Object.entries(MARKDOWN_ROUTES).map(([htmlPath, markdownPath]) => ({
        source: htmlPath,
        headers: [
          { key: 'Vary', value: 'Accept' },
          {
            key: 'Link',
            value: `${SITE_LINK_HEADER}, ${markdownAlternateLinkValue(markdownPath)}`,
          },
        ],
      })),
```

- [ ] **Step 10: Verify negotiation end to end**

Run: `bun run dev &` then:

```bash
curl -s -D - -o /dev/null -H 'Accept: text/markdown' http://localhost:3000/pricing | grep -i 'content-type\|x-markdown-tokens'
curl -s -D - -o /dev/null http://localhost:3000/pricing | grep -i 'content-type\|^vary'
```

Expected: the first prints `content-type: text/markdown; charset=utf-8` and an
`x-markdown-tokens` value; the second prints `content-type: text/html` and
`vary: Accept`.

Stop the dev server afterwards.

- [ ] **Step 11: Run the full web suite**

Run: `bun test src/lib`
Expected: PASS, no regressions.

- [ ] **Step 12: Commit**

```bash
git add apps/web/src/lib/agent-discovery/markdown-negotiation.ts \
        apps/web/src/lib/agent-discovery/markdown-negotiation.test.ts \
        apps/web/src/lib/seo/response.ts \
        apps/web/src/lib/seo/coverage-manifest.ts \
        apps/web/src/lib/seo/public-content.test.ts \
        apps/web/src/middleware.ts \
        apps/web/next.config.ts
git commit -m "feat(web): serve markdown to agents that request it via Accept negotiation"
```

---

### Task 9: WebMCP browser tools

The repository has no DOM test library — React tests use `renderToStaticMarkup`. So the tool definitions and the registration helper live in a pure module that is tested directly, and the component is a thin `useEffect` wrapper.

**Files:**
- Create: `apps/web/src/lib/agent-discovery/web-mcp-tools.ts`
- Create: `apps/web/src/lib/agent-discovery/web-mcp-tools.test.ts`
- Create: `apps/web/src/components/agent/web-mcp-tools.tsx`
- Modify: `apps/web/src/app/layout.tsx`

**Interfaces:**
- Consumes: nothing from earlier tasks
- Produces:
  - `type WebMcpTool = { name: string; description: string; inputSchema: Record<string, unknown>; execute: (input: Record<string, unknown>) => Promise<unknown> }`
  - `WEB_MCP_TOOLS: WebMcpTool[]`
  - `registerWebMcpTools(target: unknown): (() => void) | undefined`

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/lib/agent-discovery/web-mcp-tools.test.ts`:

```ts
import { describe, expect, mock, test } from 'bun:test';

import { WEB_MCP_TOOLS, registerWebMcpTools } from './web-mcp-tools';

describe('web mcp tool definitions', () => {
  test('exposes the four read-only site capabilities', () => {
    expect(WEB_MCP_TOOLS.map((tool) => tool.name).sort()).toEqual([
      'get_kortix_page_markdown',
      'get_kortix_pricing',
      'list_kortix_pages',
      'search_kortix_docs',
    ]);
  });

  test('every tool carries a description, a JSON Schema and an executor', () => {
    for (const tool of WEB_MCP_TOOLS) {
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.inputSchema.type).toBe('object');
      expect(typeof tool.execute).toBe('function');
    }
  });

  test('search forwards the query to the existing docs search endpoint', async () => {
    const fetchMock = mock(async () => new Response(JSON.stringify([{ id: 'x' }])));
    const original = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const search = WEB_MCP_TOOLS.find((tool) => tool.name === 'search_kortix_docs')!;
      await search.execute({ query: 'sessions' });
      expect(fetchMock.mock.calls[0][0]).toBe('/api/search?query=sessions');
    } finally {
      globalThis.fetch = original;
    }
  });

  test('page markdown negotiates on the page path rather than guessing a URL', async () => {
    const fetchMock = mock(async () => new Response('# Pricing'));
    const original = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const tool = WEB_MCP_TOOLS.find((t) => t.name === 'get_kortix_page_markdown')!;
      const result = await tool.execute({ path: '/pricing' });
      expect(fetchMock.mock.calls[0][0]).toBe('/pricing');
      expect(fetchMock.mock.calls[0][1].headers.Accept).toBe('text/markdown');
      expect(result).toBe('# Pricing');
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('registerWebMcpTools', () => {
  test('is inert when the browser has no WebMCP support', () => {
    expect(registerWebMcpTools({})).toBeUndefined();
  });

  test('provides the tools and returns a cleanup function', () => {
    const unregister = mock(() => {});
    const provideContext = mock(() => ({ unregister }));
    const cleanup = registerWebMcpTools({ modelContext: { provideContext } });

    expect(provideContext).toHaveBeenCalledTimes(1);
    expect(provideContext.mock.calls[0][0].tools).toHaveLength(WEB_MCP_TOOLS.length);

    cleanup?.();
    expect(unregister).toHaveBeenCalledTimes(1);
  });

  test('survives a registration that returns nothing to unregister', () => {
    const cleanup = registerWebMcpTools({ modelContext: { provideContext: () => undefined } });
    expect(() => cleanup?.()).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/lib/agent-discovery/web-mcp-tools.test.ts`
Expected: FAIL — `Cannot find module './web-mcp-tools'`.

- [ ] **Step 3: Write the tools module**

Create `apps/web/src/lib/agent-discovery/web-mcp-tools.ts`:

```ts
export type WebMcpTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (input: Record<string, unknown>) => Promise<unknown>;
};

/**
 * Every tool is read-only, unauthenticated, and backed by an endpoint that
 * already exists. Nothing here mutates state: a page-level agent surface is the
 * wrong place to expose writes.
 */
export const WEB_MCP_TOOLS: WebMcpTool[] = [
  {
    name: 'search_kortix_docs',
    description: 'Search the Kortix product documentation and return matching sections.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'What to search for.' } },
      required: ['query'],
    },
    execute: async (input) => {
      const query = String(input.query ?? '');
      const response = await fetch(`/api/search?query=${encodeURIComponent(query)}`);
      return response.json();
    },
  },
  {
    name: 'list_kortix_pages',
    description:
      'List public Kortix pages with titles, descriptions and last-modified dates. Paginated.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['marketing', 'blog', 'docs', 'use-case'],
          description: 'Restrict to one content family.',
        },
        cursor: { type: 'string', description: 'Opaque cursor from a previous call.' },
      },
    },
    execute: async (input) => {
      const params = new URLSearchParams();
      if (input.kind) params.set('kind', String(input.kind));
      if (input.cursor) params.set('cursor', String(input.cursor));
      const query = params.toString();
      const response = await fetch(`/api/ai${query ? `?${query}` : ''}`);
      return response.json();
    },
  },
  {
    name: 'get_kortix_page_markdown',
    description:
      'Fetch any public Kortix page as markdown instead of HTML. Pass the page path, e.g. /pricing.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Root-relative page path.' } },
      required: ['path'],
    },
    execute: async (input) => {
      const path = String(input.path ?? '/');
      const response = await fetch(path, { headers: { Accept: 'text/markdown' } });
      return response.text();
    },
  },
  {
    name: 'get_kortix_pricing',
    description: 'Return the current Kortix pricing plans as markdown.',
    inputSchema: { type: 'object', properties: {} },
    execute: async () => {
      const response = await fetch('/pricing', { headers: { Accept: 'text/markdown' } });
      return response.text();
    },
  },
];

type ModelContextHost = {
  modelContext?: {
    provideContext: (context: { tools: WebMcpTool[] }) => { unregister?: () => void } | undefined;
  };
};

/**
 * Registers the tools with a WebMCP host and returns a cleanup function.
 * Returns undefined when the browser has no WebMCP support, so callers stay
 * inert rather than throwing.
 */
export function registerWebMcpTools(target: unknown): (() => void) | undefined {
  const host = target as ModelContextHost | null;
  const provideContext = host?.modelContext?.provideContext;
  if (typeof provideContext !== 'function') return undefined;

  const registration = provideContext.call(host!.modelContext, { tools: WEB_MCP_TOOLS });
  return () => registration?.unregister?.();
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test src/lib/agent-discovery/web-mcp-tools.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Write the mounting component**

Create `apps/web/src/components/agent/web-mcp-tools.tsx`:

```tsx
'use client';

import { useEffect } from 'react';

import { registerWebMcpTools } from '@/lib/agent-discovery/web-mcp-tools';

/**
 * Exposes Kortix's read-only site capabilities to a WebMCP-capable browser
 * agent. Renders nothing. Cleanup on unmount matters because client navigation
 * would otherwise stack registrations.
 */
export function WebMcpTools(): null {
  useEffect(() => registerWebMcpTools(navigator), []);
  return null;
}
```

- [ ] **Step 6: Mount it in the root layout**

In `apps/web/src/app/layout.tsx`, add to the imports:

```tsx
import { WebMcpTools } from '@/components/agent/web-mcp-tools';
```

Then place `<WebMcpTools />` immediately before `<KortixProjectScope>{children}</KortixProjectScope>`
(line 339), inside the same parent element.

- [ ] **Step 7: Verify the app still renders**

Run: `bun run build 2>&1 | tail -20`
Expected: build succeeds.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/lib/agent-discovery/web-mcp-tools.ts \
        apps/web/src/lib/agent-discovery/web-mcp-tools.test.ts \
        apps/web/src/components/agent/web-mcp-tools.tsx \
        apps/web/src/app/layout.tsx
git commit -m "feat(web): expose read-only site tools to browser agents via WebMCP"
```

---

### Task 10: DNS-AID and MCP server card documentation

Neither can be satisfied honestly by code here: DNS-AID is zone configuration, and no MCP server exists anywhere in this repository. This task produces the exact artifacts a human applies.

**Files:**
- Create: `docs/agent-discovery/dns-aid.md`

**Interfaces:**
- Consumes: the endpoint URLs established in Task 1
- Produces: nothing consumed by code

- [ ] **Step 1: Write the document**

Create `docs/agent-discovery/dns-aid.md`:

````markdown
# DNS-based agent discovery for kortix.com

Two agent-discovery affordances cannot be satisfied from this repository. This
document holds the exact artifacts so whoever has the access can apply them.

## DNS for AI Discovery (DNS-AID)

Per `draft-mozleywilliams-dnsop-dnsaid` and RFC 9460, publish ServiceMode
SVCB records under the `_agents` label. These point agents at the discovery
documents this repository already serves.

### Records

```
_index._agents.kortix.com. 3600 IN SVCB 1 kortix.com. (
    alpn="h2,h3"
    port=443
    endpoint="/.well-known/api-catalog" )

_a2a._agents.kortix.com.   3600 IN SVCB 1 kortix.com. (
    alpn="h2,h3"
    port=443
    endpoint="/.well-known/agent-skills/index.json" )
```

`_index` is the general entrypoint: it resolves to the API catalog, which in
turn links the OpenAPI document, the human docs, and the health endpoint.
`_a2a` resolves to the agent skills index.

### Cloudflare

Cloudflare's dashboard exposes SVCB under **DNS → Records → Add record → SVCB**.
Set Name to `_index._agents`, Priority to `1`, Target to `kortix.com`, and put
the parameters in the Value field as `alpn="h2,h3" port=443
endpoint="/.well-known/api-catalog"`. Repeat for `_a2a._agents`.

Via the API:

```bash
curl -X POST "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records" \
  -H "Authorization: Bearer $CF_API_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{
    "type": "SVCB",
    "name": "_index._agents.kortix.com",
    "ttl": 3600,
    "data": {
      "priority": 1,
      "target": "kortix.com",
      "value": "alpn=\"h2,h3\" port=443 endpoint=\"/.well-known/api-catalog\""
    }
  }'
```

### DNSSEC

The draft expects validating resolvers to return authenticated data, so the zone
must be signed. On Cloudflare: **DNS → Settings → DNSSEC → Enable**, then copy
the DS record it produces into the registrar for `kortix.com`. Discovery records
served from an unsigned zone are spoofable, which defeats the point of putting
them in DNS at all.

### Verifying

```bash
dig +short SVCB _index._agents.kortix.com
dig +dnssec SVCB _index._agents.kortix.com | grep -c RRSIG   # expect 1 or more
```

## MCP Server Card — not published

`/.well-known/mcp/server-card.json` (SEP-1649) is deliberately absent. There is
no MCP server anywhere in this repository: no `@modelcontextprotocol/*`
dependency, no transport endpoint, no tool registry. A card is a promise that an
agent will act on by connecting, so publishing one that points nowhere is worse
than publishing nothing.

Once an MCP transport endpoint exists, publish this document — filling in the
real endpoint URL and the capabilities the server actually implements:

```json
{
  "serverInfo": {
    "name": "kortix",
    "version": "1.0.0"
  },
  "transport": {
    "type": "streamable-http",
    "endpoint": "https://api.kortix.com/v1/mcp"
  },
  "capabilities": {
    "tools": {},
    "resources": {}
  }
}
```

Serve it the same way as the other discovery documents: a route handler under
`apps/web/src/app/(public)/well-known/mcp/server-card.json/`, plus a rewrite from
`/.well-known/mcp/server-card.json` in `next.config.ts`. Add `mcp-server-card` to
`DISCOVERY_PATHS` in `src/lib/agent-discovery/link-header.ts` at the same time so
the site-wide `Link` header advertises it.
````

- [ ] **Step 2: Verify the document is complete**

Run: `grep -c 'TBD\|TODO\|FIXME' docs/agent-discovery/dns-aid.md`
Expected: `0`.

- [ ] **Step 3: Commit**

```bash
git add docs/agent-discovery/dns-aid.md
git commit -m "docs: record the DNS-AID records and MCP server card gate"
```

---

## Final verification

- [ ] **Run the full web test suite**

Run: `bun test`
Expected: PASS, no regressions.

- [ ] **Build**

Run: `bun run build`
Expected: success.

- [ ] **Smoke-test every discovery path against a local server**

Run: `bun run dev &` then:

```bash
for path in \
  /.well-known/api-catalog \
  /.well-known/oauth-authorization-server \
  /.well-known/oauth-protected-resource \
  /.well-known/agent-skills/index.json \
  /.well-known/agent-skills/kortix-api/SKILL.md \
  /auth.md \
  /robots.txt
do
  printf '%s -> %s\n' "$path" "$(curl -s -o /dev/null -w '%{http_code} %{content_type}' "http://localhost:3000$path")"
done
curl -sI http://localhost:3000/ | grep -i '^link:'
curl -s -o /dev/null -w '%{content_type}\n' -H 'Accept: text/markdown' http://localhost:3000/pricing
```

Expected: every path returns `200` with the content type its task specified; the
homepage emits the `Link` header; `/pricing` under `Accept: text/markdown`
returns `text/markdown; charset=utf-8`.

Stop the dev server afterwards.
