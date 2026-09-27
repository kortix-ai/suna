/**
 * Tripwire: request primitives have one implementation each.
 *
 *   client address   → shared/client-ip.ts (requestClientIp, requestClientKey)
 *   UUID shape check → shared/validate.ts  (isUuid)
 *   JSON object body → shared/http-body.ts (readJsonObject)
 *   HTML escaping    → shared/html.ts      (escapeHtml)
 *
 * A private copy drifts. An address read outside the trusted-proxy rule is not
 * the address KORTIX_TRUSTED_PROXY_HOPS selects, and a strict UUID regex refuses
 * ids a looser one accepted on write. An inline `c.req.json().catch(() => ({}))`
 * returns JSON `null` as `null`, so `body.x` throws a TypeError (a 500). An
 * inline `(await c.req.json()) ?? {}` returns a scalar body as-is, so
 * `'x' in body` throws a TypeError (a 500).
 * This test fails on a new copy in non-test source under apps/api/src.
 *
 * Out of scope: `c.req.json().catch(() => null)` sites. They pass the result to
 * a zod `safeParse` or read it with `?.`, so a JSON `null` body is a 400.
 *
 * Every allowlist entry names its reason. Remove an entry when its reason ends.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const SRC = join(import.meta.dir, '..');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === '__tests__') continue;
      out.push(...sourceFiles(full));
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

const FILES = sourceFiles(SRC).map((full) => ({
  rel: relative(SRC, full).split(sep).join('/'),
  text: readFileSync(full, 'utf8'),
}));

function offenders(pattern: RegExp, allow: Record<string, string>): string[] {
  return FILES.filter(({ rel, text }) => !(rel in allow) && pattern.test(text)).map(({ rel }) => rel);
}

function staleAllowlist(pattern: RegExp, allow: Record<string, string>): string[] {
  return Object.keys(allow).filter((rel) => {
    const file = FILES.find((f) => f.rel === rel);
    return !file || !pattern.test(file.text);
  });
}

// The header name as a call argument or an index: `header('x-forwarded-for')`,
// `.get("X-Forwarded-For")`, `headers['x-forwarded-for']`. Prose that names the
// header does not match.
const XFF_READ = /[([]\s*['"`]x-forwarded-for['"`]/i;
const XFF_ALLOW: Record<string, string> = {
  'shared/client-ip.ts': 'the one implementation',
  'platform/services/sandbox-egress-pin.ts':
    'reads cf-connecting-ip first and pins the sandbox egress address; a deliberate special case',
  'auth/gotrue.ts': 'sets the header on an outbound request to GoTrue',
  // TODO(follow-up): convert once the SCIM identity work lands on main.
  'scim/app.ts': 'open SCIM work edits this file; convert in a follow-up',
  // TODO(follow-up): convert once PR #7403 lands. The raw header is stored on
  // purpose as webhook delivery metadata, so the follow-up keeps the raw value.
  'projects/lib/triggers.ts': 'open PR #7403 edits this file; stores the raw header as webhook metadata',
};

// Any 8-4-4-4-12 hex regex literal, strict or loose.
const UUID_LITERAL = /\[0-9a-f\]\{8\}-/i;
const UUID_ALLOW: Record<string, string> = {
  'shared/validate.ts': 'the one implementation',
  // TODO(follow-up): convert once each open change lands.
  'connectors/db-deps.ts': 'open PR #7236 edits this file',
  'iam/sso-sync.ts': 'open SSO identity work edits this file',
};

// An inline JSON body read that falls back to `{}`, in either form:
//   c.req.json().catch(() => ({}))
//   try { body = (await c.req.json()) ?? {}; } catch {}
const JSON_OBJECT_INLINE = new RegExp(
  [
    /\.req\.json(?:<[^>]*>)?\(\)\s*\.catch\(\s*\(\)\s*=>\s*\(\s*\{\s*\}\s*\)\s*\)/.source,
    /\.req\.json(?:<[^>]*>)?\(\)\s*\)\s*\?\?\s*\{\s*\}/.source,
  ].join('|'),
);
const JSON_OBJECT_ALLOW: Record<string, string> = {};

const ESCAPE_HTML_DEF = /function\s+escapeHtml\b|\bescapeHtml\s*=\s*(?:\(|function)/;
const ESCAPE_HTML_ALLOW: Record<string, string> = {
  'shared/html.ts': 'the one implementation',
  // TODO(follow-up): import shared/html.ts once PR #7180 lands.
  'apps/public-proxy.ts': 'open PR #7180 edits this file',
};

describe('request primitives have one implementation', () => {
  test('X-Forwarded-For is read only in shared/client-ip.ts', () => {
    expect(offenders(XFF_READ, XFF_ALLOW)).toEqual([]);
    expect(staleAllowlist(XFF_READ, XFF_ALLOW)).toEqual([]);
  });

  test('UUID regex literals live only in shared/validate.ts', () => {
    expect(offenders(UUID_LITERAL, UUID_ALLOW)).toEqual([]);
    expect(staleAllowlist(UUID_LITERAL, UUID_ALLOW)).toEqual([]);
  });

  test('the JSON object pattern matches both inline forms', () => {
    expect(JSON_OBJECT_INLINE.test('const body = await c.req.json().catch(() => ({}));')).toBe(true);
    expect(JSON_OBJECT_INLINE.test('await c.req.json<Foo>().catch(() => ({ }))')).toBe(true);
    expect(JSON_OBJECT_INLINE.test('try { body = (await c.req.json()) ?? {}; } catch {}')).toBe(true);
    expect(JSON_OBJECT_INLINE.test('body = (await c.req.json<Foo>())  ??  { };')).toBe(true);
    expect(JSON_OBJECT_INLINE.test('const body = await c.req.json().catch(() => null);')).toBe(false);
    expect(JSON_OBJECT_INLINE.test('const body = await readJsonObject(c);')).toBe(false);
  });

  test('JSON object bodies are read only through shared/http-body.ts', () => {
    expect(offenders(JSON_OBJECT_INLINE, JSON_OBJECT_ALLOW)).toEqual([]);
    expect(staleAllowlist(JSON_OBJECT_INLINE, JSON_OBJECT_ALLOW)).toEqual([]);
  });

  test('escapeHtml is defined only in shared/html.ts', () => {
    expect(offenders(ESCAPE_HTML_DEF, ESCAPE_HTML_ALLOW)).toEqual([]);
    expect(staleAllowlist(ESCAPE_HTML_DEF, ESCAPE_HTML_ALLOW)).toEqual([]);
  });

  test('the scan sees the source tree', () => {
    expect(FILES.length).toBeGreaterThan(500);
    expect(FILES.some((f) => f.rel === 'shared/client-ip.ts')).toBe(true);
  });
});
