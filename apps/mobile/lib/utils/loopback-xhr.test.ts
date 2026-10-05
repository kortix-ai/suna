import { describe, expect, test } from 'bun:test';

import { installLoopbackRewrite } from './loopback-xhr';

function fakeXhrClass() {
  class FakeXhr {
    opened: [string, string] | null = null;
    open(method: string, url: string) {
      this.opened = [method, url];
    }
  }
  return FakeXhr;
}

const toLan = (url: string) => url.replace('127.0.0.1', '192.168.0.10').replace('localhost', '192.168.0.10');

describe('installLoopbackRewrite', () => {
  test('a signed Storage URL on 127.0.0.1 opens on the dev host', () => {
    const Xhr = fakeXhrClass();
    installLoopbackRewrite(Xhr, toLan);
    const xhr = new Xhr();
    xhr.open('PUT', 'http://127.0.0.1:54321/storage/v1/object/upload/sign/b/o?token=t');
    expect(xhr.opened).toEqual(['PUT', 'http://192.168.0.10:54321/storage/v1/object/upload/sign/b/o?token=t']);
  });

  test('a non-loopback URL opens unchanged', () => {
    const Xhr = fakeXhrClass();
    installLoopbackRewrite(Xhr, toLan);
    const xhr = new Xhr();
    xhr.open('PUT', 'https://storage.example.com/o?token=t');
    expect(xhr.opened).toEqual(['PUT', 'https://storage.example.com/o?token=t']);
  });

  test('installing twice rewrites once', () => {
    const Xhr = fakeXhrClass();
    let calls = 0;
    const counting = (url: string) => {
      calls += 1;
      return toLan(url);
    };
    installLoopbackRewrite(Xhr, counting);
    installLoopbackRewrite(Xhr, counting);
    new Xhr().open('GET', 'http://localhost:8008/v1/health');
    expect(calls).toBe(1);
  });
});
