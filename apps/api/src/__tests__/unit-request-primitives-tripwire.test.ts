/**
 * Tripwire: request primitives have one implementation each.
 *
 *   client address   → shared/client-ip.ts   (clientIpFromHeaders, requestClientIp)
 *   UUID shape check → shared/validate.ts    (isUuid, UUID_RE)
 *   HTML escaping    → lib/email/template.ts (escapeHtml)
 *
 * A private copy drifts. The leftmost X-Forwarded-For entry is written by the
 * caller, and a strict UUID regex refuses ids a looser one accepted on write.
 * This test fails on a new copy in non-test source under apps/api/src.
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
  'projects/routes/channel-teams.ts': 'open PR #7633 edits this file',
  'iam/sso-sync.ts': 'open SSO identity work edits this file',
};

const ESCAPE_HTML_DEF = /function\s+escapeHtml\b|\bescapeHtml\s*=\s*(?:\(|function)/;
const ESCAPE_HTML_ALLOW: Record<string, string> = {
  'lib/email/template.ts': 'the one implementation',
  // TODO(follow-up): import lib/email/template.ts once PR #7180 lands.
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

  test('escapeHtml is defined only in lib/email/template.ts', () => {
    expect(offenders(ESCAPE_HTML_DEF, ESCAPE_HTML_ALLOW)).toEqual([]);
    expect(staleAllowlist(ESCAPE_HTML_DEF, ESCAPE_HTML_ALLOW)).toEqual([]);
  });

  test('the scan sees the source tree', () => {
    expect(FILES.length).toBeGreaterThan(500);
    expect(FILES.some((f) => f.rel === 'shared/client-ip.ts')).toBe(true);
  });
});
