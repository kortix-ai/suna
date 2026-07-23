import { describe, expect, it } from 'bun:test';
import { mergePortApps, portToAppOutput, urlPort } from './port-apps';

describe('port apps', () => {
  it('maps a port to an app OutputItem', () => {
    expect(portToAppOutput(3000)).toEqual({
      callID: 'port:3000',
      name: 'localhost:3000',
      kind: 'app',
      url: 'http://localhost:3000',
    });
  });
  it('port-derived apps are never marked fresh (payoff must ignore them)', () => {
    expect(portToAppOutput(3000).fresh).toBeUndefined();
  });
  it('extracts ports from event-app urls (default ports included)', () => {
    expect(urlPort('http://localhost:3000')).toBe(3000);
    expect(urlPort('http://localhost:3000/dash')).toBe(3000);
    expect(urlPort('https://example.com')).toBe(443);
    expect(urlPort('not a url')).toBeNull();
  });
  it('event-derived apps win over port-derived on the same port', () => {
    const shown = {
      callID: 'c1',
      name: 'My dashboard',
      title: 'My dashboard',
      kind: 'app' as const,
      url: 'http://localhost:3000',
      shown: true,
    };
    const merged = mergePortApps([shown], [portToAppOutput(3000), portToAppOutput(5173)]);
    expect(merged.map((a) => a.callID)).toEqual(['c1', 'port:5173']);
  });
  it('with no ports the event list is returned as-is (regression)', () => {
    const shown = { callID: 'c1', name: 'x', kind: 'app' as const, url: 'http://localhost:3000' };
    expect(mergePortApps([shown], [])).toEqual([shown]);
  });
});
