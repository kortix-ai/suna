import { describe, expect, test } from 'bun:test';

import {
  discoverLogoSource,
  installedConnectorLogoSource,
  resolveConnectorLogo,
} from './connector-logo-source';

/**
 * One logo per app on every surface: the same app given as a catalogue record
 * or as an installed connector resolves to the same logo.
 */
describe('resolveConnectorLogo', () => {
  test('a Kortix-built connector is its own mark, however it is named', () => {
    for (const source of [
      { nativeApp: 'email' },
      { slug: 'native:email' },
      { slug: 'kortix_email' },
      { provider: 'channel', platform: 'email' },
      { slug: 'email_inbox', icon: '/connector-icons/email.svg' },
    ]) {
      expect(resolveConnectorLogo(source)).toEqual({ kind: 'native', app: 'email' });
    }
    expect(resolveConnectorLogo({ slug: 'kortix_telegram' })).toEqual({ kind: 'native', app: 'telegram' });
    expect(resolveConnectorLogo({ provider: 'computer', slug: 'computer' })).toEqual({
      kind: 'native',
      app: 'computer',
    });
  });

  test('the catalogue card and the installed connector of one app agree', () => {
    const card = discoverLogoSource({
      id: 'native:slack',
      icon: '/connector-icons/slack.svg',
      domain: 'slack.com',
      kortix: { app: 'slack' },
    });
    const installed = installedConnectorLogoSource({ slug: 'kortix_slack', provider: 'channel', platform: 'slack' });
    expect(resolveConnectorLogo(card)).toEqual(resolveConnectorLogo(installed));

    const stripeCard = discoverLogoSource({ id: 'kortix:stripe', icon: '/connector-icons/stripe.svg', domain: 'stripe.com' });
    const stripeInstalled = installedConnectorLogoSource({ slug: 'stripe', provider: 'mcp', iconUrl: '/connector-icons/stripe.svg' });
    expect(resolveConnectorLogo(stripeCard)).toEqual(resolveConnectorLogo(stripeInstalled));
  });

  test("an app's own icon, then a public catalogue domain's favicon", () => {
    // A Kortix-shaped slug or icon path of an app that is neither a Kortix channel nor Computer is not a native mark.
    expect(resolveConnectorLogo({ slug: 'kortix_stripe', icon: '/connector-icons/stripe.svg' })).toEqual({
      kind: 'image',
      src: '/connector-icons/stripe.svg',
    });
    expect(resolveConnectorLogo({ icon: 'https://logos.composio.dev/api/gmail' })).toEqual({
      kind: 'image',
      src: 'https://logos.composio.dev/api/gmail',
    });
    expect(resolveConnectorLogo({ domain: 'www.linear.app' })).toEqual({
      kind: 'image',
      src: 'https://www.google.com/s2/favicons?domain=linear.app&sz=128',
    });
  });

  test('nothing to show is the neutral fallback, never a favicon of a private host', () => {
    expect(resolveConnectorLogo({ slug: 'internal-api', provider: 'mcp' })).toEqual({ kind: 'none' });
    expect(resolveConnectorLogo({})).toEqual({ kind: 'none' });
  });
});
