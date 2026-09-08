// A SESSION'S ENV MUST REACH ITS OWN ISOLATE.
//
// A cell sandbox holds one isolate per session and picks between them with
// `?c=`. Without it every session's env landed in one isolate: measured on dev
// 2026-09-09, two sessions on one box both reported {"keys":[]} after
// `[env-sync] push=sent`, ran with credential.length 0, and hung on every model
// call — surfacing to the user as a session that answers with the scripted
// fixture ("I ran the command and wrote proof.txt") instead of a model.
import { describe, expect, test } from 'bun:test';
import { envPushUrl } from './env-push-url';

describe('the env push target', () => {
  test('names the session, so a cell puts it in that session\'s isolate', () => {
    expect(envPushUrl('https://8080-abc.example', 'sess-1'))
      .toBe('https://8080-abc.example/kortix/env?c=sess-1');
  });

  test('two sessions on one box get two different targets — the whole point', () => {
    const a = envPushUrl('https://8080-abc.example', 'a');
    const b = envPushUrl('https://8080-abc.example', 'b');
    expect(a).not.toBe(b);
  });

  test('a trailing slash on the preview URL does not double up', () => {
    expect(envPushUrl('https://8080-abc.example/', 'sess-1'))
      .toBe('https://8080-abc.example/kortix/env?c=sess-1');
    expect(envPushUrl('https://8080-abc.example///', 'sess-1'))
      .toBe('https://8080-abc.example/kortix/env?c=sess-1');
  });

  test('an id that needs escaping is escaped, never injected raw', () => {
    expect(envPushUrl('https://x.example', 'a/b?c=d&e'))
      .toBe('https://x.example/kortix/env?c=a%2Fb%3Fc%3Dd%26e');
  });

  test('with no session it is the plain path — a daemon addressed as before', () => {
    expect(envPushUrl('https://x.example', null)).toBe('https://x.example/kortix/env');
    expect(envPushUrl('https://x.example', undefined)).toBe('https://x.example/kortix/env');
    expect(envPushUrl('https://x.example', '   ')).toBe('https://x.example/kortix/env');
  });
});
