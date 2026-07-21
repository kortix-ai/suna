import { describe, expect, test } from 'bun:test';
import { CHANNEL_PLATFORMS } from '@kortix/manifest-schema';

/**
 * Connecting a channel writes an install; synthesizeChannelConnectors is what
 * turns that install into a connector the project can actually see. A platform
 * added to CHANNEL_PLATFORMS without a branch here connects "successfully" and
 * then shows up nowhere — the project just reports {"connectors":[]}.
 *
 * Assert from source so this needs no database.
 */
const SOURCE = await Bun.file(
  new URL('../executor/channel-materialize.ts', import.meta.url).pathname,
).text();

describe('synthesizeChannelConnectors covers every channel platform', () => {
  for (const platform of CHANNEL_PLATFORMS) {
    test(`materializes "${platform}"`, () => {
      expect(SOURCE).toContain(`'${platform}'`);
    });
  }

  test('WhatsApp is materialized before the email early-return', () => {
    const whatsappAt = SOURCE.indexOf("resolveExperimentalFeature(project.metadata, 'whatsapp')");
    const emailReturnAt = SOURCE.indexOf("'agentmail_email')) {");
    expect(whatsappAt).toBeGreaterThan(-1);
    expect(emailReturnAt).toBeGreaterThan(-1);
    // Otherwise a project without the email flag never gets its WhatsApp connector.
    expect(whatsappAt).toBeLessThan(emailReturnAt);
  });
});
