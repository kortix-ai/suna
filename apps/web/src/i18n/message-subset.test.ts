import { describe, expect, test } from 'bun:test';
import { createTranslator } from 'next-intl';
import { runInNewContext } from 'node:vm';

import en from '../../translations/en.json';
import {
  CLIENT_BOOT_GLOBAL,
  clientBootScript,
  createMessageRecorder,
  mergeMessagesInPlace,
  type ClientBoot,
  type MessageTree,
} from './message-subset';

const catalog = {
  common: { save: 'Save', cancel: 'Cancel', greet: 'Hello {name}' },
  deep: { a: { b: 'B', c: 'C' } },
  list: ['one', 'two'],
  enumerated: { x: 'X', y: 'Y' },
  unused: { big: 'never read' },
};

function runBoot(scripts: string[]): ClientBoot {
  const window: Record<string, unknown> = {};
  for (const script of scripts) runInNewContext(script, { window });
  return window[CLIENT_BOOT_GLOBAL] as ClientBoot;
}

describe('message recorder', () => {
  test('records only the entries a render reads', () => {
    const recorder = createMessageRecorder(structuredClone(catalog));
    const t = createTranslator({ locale: 'en', messages: recorder.messages as never });
    expect(t('common.save' as never)).toBe('Save');
    expect(t('deep.a.b' as never)).toBe('B');
    expect(recorder.takeDelta()).toEqual({ common: { save: 'Save' }, deep: { a: { b: 'B' } } });
    expect(recorder.takeDelta()).toBeNull();
  });

  test('arrays and enumerated objects are recorded whole', () => {
    const recorder = createMessageRecorder(structuredClone(catalog));
    const messages = recorder.messages as typeof catalog;
    expect(messages.list[1]).toBe('two');
    expect(Object.keys(messages.enumerated)).toEqual(['x', 'y']);
    expect(recorder.takeDelta()).toEqual({ list: ['one', 'two'], enumerated: { x: 'X', y: 'Y' } });
  });

  test('a missing entry records nothing and stays missing in the subset', () => {
    const recorder = createMessageRecorder(structuredClone(catalog));
    const t = createTranslator({
      locale: 'en',
      messages: recorder.messages as never,
      onError: () => {},
    });
    expect(t.has('common.nope' as never)).toBe(false);
    expect(recorder.takeDelta()).toBeNull();
  });

  test('boot scripts rebuild a subset that renders identically, across streamed flushes', () => {
    const recorder = createMessageRecorder(structuredClone(en) as MessageTree);
    const server = createTranslator({
      locale: 'en',
      messages: recorder.messages as never,
      namespace: 'hardcodedUi.i18nComplete',
    });
    const first = server.raw('textce34af36d804' as never);
    const scripts = [clientBootScript('en', recorder.takeDelta()!)];
    const second = server.raw('text2bf70270bfde' as never);
    scripts.push(clientBootScript('en', recorder.takeDelta()!));

    const boot = runBoot(scripts);
    expect(boot.l).toBe('en');
    const client = createTranslator({
      locale: 'en',
      messages: boot.m as never,
      namespace: 'hardcodedUi.i18nComplete',
    });
    expect(client.raw('textce34af36d804' as never)).toBe(first);
    expect(client.raw('text2bf70270bfde' as never)).toBe(second);
    // The subset is a tiny fraction of the 1.3 MB catalog.
    expect(JSON.stringify(boot.m).length).toBeLessThan(2_000);
  });

  test('boot script escapes markup inside messages', () => {
    const script = clientBootScript('en', { a: '</script><b>&' });
    expect(script).not.toContain('</script>');
    expect(runBoot([script]).m).toEqual({ a: '</script><b>&' });
  });

  test('a boot script for another locale replaces the previous subset', () => {
    const boot = runBoot([clientBootScript('en', { a: 'A' }), clientBootScript('de', { b: 'B' })]);
    expect(boot).toEqual({ l: 'de', m: { b: 'B' } });
  });

  test('mergeMessagesInPlace keeps nested object identity', () => {
    const nested = { a: 'A' };
    const target: MessageTree = { ns: nested };
    mergeMessagesInPlace(target, { ns: { b: 'B' }, top: 'T' });
    expect(target.ns).toBe(nested);
    expect(target).toEqual({ ns: { a: 'A', b: 'B' }, top: 'T' });
  });
});
