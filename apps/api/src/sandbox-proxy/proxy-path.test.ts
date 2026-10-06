import { describe, expect, test } from 'bun:test';
import { isTurnStartEnvSync } from './pre-prompt-env-sync';
import { canonicalProxyPath } from './proxy-path';
import { classifyRuntimeRequest } from './runtime-request';

describe('canonicalProxyPath', () => {
  test('decodes unreserved escapes so every gate reads the daemon spelling', () => {
    expect(canonicalProxyPath('/session/s1/prompt%5Fasync', true)).toBe('/session/s1/prompt_async');
    expect(canonicalProxyPath('/session/s1/prompt%5fasync', true)).toBe('/session/s1/prompt_async');
    expect(canonicalProxyPath('/kortix/%65nv', true)).toBe('/kortix/env');
    expect(canonicalProxyPath('/kortix/runtime/sessions/s1/pr%6Fmpt', true)).toBe('/kortix/runtime/sessions/s1/prompt');
    expect(canonicalProxyPath('/session/s1/messag%65?limit=5', true)).toBe('/session/s1/message?limit=5');
  });

  test('keeps escapes of reserved and non-ASCII characters, upper-cased', () => {
    expect(canonicalProxyPath('/file/a%20b%c3%a9', true)).toBe('/file/a%20b%C3%A9');
    expect(canonicalProxyPath('/file/100%25', true)).toBe('/file/100%25');
  });

  test('collapses empty segments', () => {
    expect(canonicalProxyPath('/kortix//env', true)).toBe('/kortix/env');
    expect(canonicalProxyPath('//session/s1/prompt_async', true)).toBe('/session/s1/prompt_async');
  });

  test('strict mode refuses ambiguous input', () => {
    for (const path of ['/a%2Fb', '/a%2fb', '/a%5Cb', '/a%00b', '/a%zz', '/a%4', '/a%', '/a/%2e%2e/b', '/a/%2E/b']) {
      expect(canonicalProxyPath(path, true)).toBeNull();
    }
  });

  test('non-strict mode only decodes unreserved escapes and never refuses', () => {
    expect(canonicalProxyPath('/app/a%2Fb', false)).toBe('/app/a%2Fb');
    expect(canonicalProxyPath('/app/%zz//x', false)).toBe('/app/%zz//x');
    expect(canonicalProxyPath('/app/%61', false)).toBe('/app/a');
  });

  test('a path with nothing to normalize comes back untouched', () => {
    expect(canonicalProxyPath('/session/s1/prompt_async', true)).toBe('/session/s1/prompt_async');
  });

  test('every encoded spelling of a gated path gets the verdict of the plain spelling', () => {
    const gated: Array<[string, string]> = [
      ['POST', '/kortix/runtime/sessions/s1/prompt'],
      ['POST', '/kortix/opencode/sessions/s1/abort'],
      ['POST', '/session/s1/prompt_async'],
      ['POST', '/session/s1/command'],
      ['POST', '/session/s1/summarize'],
      ['POST', '/session/s1/abort'],
      ['GET', '/session/s1/message'],
      ['POST', '/proxy/4096/session/s1/prompt_async'],
    ];
    const encode = (p: string) => p.replace(/[a-z_]/g, (ch, i) => (i % 2 ? `%${ch.charCodeAt(0).toString(16)}` : ch));
    for (const [method, plain] of gated) {
      const spelled = canonicalProxyPath(encode(plain), true)!;
      expect(spelled).toBe(plain);
      expect(classifyRuntimeRequest(method, spelled)).toEqual(classifyRuntimeRequest(method, plain));
      expect(classifyRuntimeRequest(method, spelled).kind).not.toBe('other');
      expect(isTurnStartEnvSync(8000, method, spelled)).toBe(isTurnStartEnvSync(8000, method, plain));
    }
  });
});
