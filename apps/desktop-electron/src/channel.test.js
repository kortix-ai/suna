const { describe, it, expect } = require('bun:test');
const {
  CHANNELS,
  CHANNEL_NAMES,
  buildUserAgent,
  channelConfig,
  resolveChannel,
  resolveScheme,
} = require('./channel');

describe('channel identities', () => {
  it('defines exactly the three shipped channels', () => {
    expect(CHANNEL_NAMES.sort()).toEqual(['dev', 'stable', 'staging']);
  });

  // The whole point of this module: three installs on one machine. If any of
  // these four values repeats across channels, two builds collide in the OS.
  it.each(['productName', 'appId', 'scheme', 'icon'])('gives every channel a unique %s', (key) => {
    const values = CHANNEL_NAMES.map((n) => CHANNELS[n][key]);
    expect(new Set(values).size).toBe(CHANNEL_NAMES.length);
  });

  it('gives every channel a distinct target URL', () => {
    const urls = CHANNEL_NAMES.map((n) => CHANNELS[n].url);
    expect(new Set(urls).size).toBe(CHANNEL_NAMES.length);
  });

  // Renaming stable orphans every existing install's userData folder and every
  // kortix:// registration already in the wild. These four values are frozen.
  it('never renames the stable identity', () => {
    expect(CHANNELS.stable).toMatchObject({
      productName: 'Kortix',
      appId: 'com.kortix.desktop',
      scheme: 'kortix',
      icon: 'icon',
    });
  });

  it('namespaces non-stable appIds under the stable one', () => {
    expect(CHANNELS.dev.appId).toBe('com.kortix.desktop.dev');
    expect(CHANNELS.staging.appId).toBe('com.kortix.desktop.staging');
  });

  // A scheme must be a legal URL scheme: letters, digits, +/-/. after a letter.
  it.each(CHANNEL_NAMES)('gives %s a syntactically valid URL scheme', (name) => {
    expect(CHANNELS[name].scheme).toMatch(/^[a-z][a-z0-9+.-]*$/);
  });
});

describe('channelConfig', () => {
  it('returns the definition for a known channel', () => {
    expect(channelConfig('dev').productName).toBe('Kortix Dev');
  });

  // A CI typo must fail the build, not quietly ship a second app claiming the
  // production bundle id.
  it('throws on an unknown channel', () => {
    expect(() => channelConfig('prod')).toThrow(/Unknown desktop channel "prod"/);
    expect(() => channelConfig('')).toThrow();
  });
});

describe('resolveChannel', () => {
  it('defaults to stable when unset', () => {
    expect(resolveChannel({})).toBe('stable');
    expect(resolveChannel(null)).toBe('stable');
    expect(resolveChannel(undefined)).toBe('stable');
  });

  it('reads the baked channel', () => {
    expect(resolveChannel({ kortixUpdateChannel: 'dev' })).toBe('dev');
    expect(resolveChannel({ kortixUpdateChannel: 'staging' })).toBe('staging');
  });
});

describe('resolveScheme', () => {
  it('prefers the explicitly baked scheme', () => {
    expect(resolveScheme({ kortixUrlScheme: 'kortix-dev' })).toBe('kortix-dev');
  });

  // Builds produced before kortixUrlScheme existed still bake the channel, so
  // derive from it rather than defaulting a dev build onto the prod scheme.
  it('falls back to the channel scheme when none is baked', () => {
    expect(resolveScheme({ kortixUpdateChannel: 'dev' })).toBe('kortix-dev');
    expect(resolveScheme({ kortixUpdateChannel: 'staging' })).toBe('kortix-staging');
  });

  it('falls back to stable for an empty or unknown package', () => {
    expect(resolveScheme({})).toBe('kortix');
    expect(resolveScheme(null)).toBe('kortix');
    expect(resolveScheme({ kortixUpdateChannel: 'nonsense' })).toBe('kortix');
  });
});

describe('buildUserAgent', () => {
  const ELECTRON_UA =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Kortix Dev/9.9.9 Chrome/140.0.0.0 Electron/39.8.10 Safari/537.36';

  it('strips Electron and the per-channel product token', () => {
    const ua = buildUserAgent(ELECTRON_UA, 'Kortix Dev', 'KortixDesktop/0.1.0', 'kortix-dev');
    // Google rejects embedded-webview UAs, so Electron must not survive.
    expect(ua).not.toContain('Electron/');
    // "Kortix Dev/9.9.9" would leak the channel into every third-party request.
    expect(ua).not.toContain('Kortix Dev/9.9.9');
    expect(ua).toContain('Chrome/140.0.0.0');
  });

  it('appends the desktop marker the web middleware keys off', () => {
    const ua = buildUserAgent(ELECTRON_UA, 'Kortix Dev', 'KortixDesktop/0.1.0', 'kortix-dev');
    expect(ua).toContain('KortixDesktop/0.1.0');
  });

  // This is the link that lets the OAuth bounce find its way back to THIS
  // build. apps/web/src/lib/desktop.ts parses it with the regex asserted below.
  it('advertises the channel scheme in a form the web app can parse', () => {
    for (const name of CHANNEL_NAMES) {
      const { productName, scheme } = CHANNELS[name];
      const ua = buildUserAgent(
        ELECTRON_UA.replace('Kortix Dev/9.9.9', `${productName}/9.9.9`),
        productName,
        'KortixDesktop/0.1.0',
        scheme,
      );
      expect(ua).toContain(`KortixScheme/${scheme}`);
      // Mirrors desktopUrlScheme() in apps/web/src/lib/desktop.ts.
      expect(/KortixScheme\/([a-z][a-z0-9+.-]*)/.exec(ua)?.[1]).toBe(scheme);
    }
  });

  // "Kortix Staging" contains no regex metacharacters today, but the name is
  // interpolated into a RegExp — a future rename must not blow it up.
  it('escapes regex metacharacters in the product name', () => {
    const ua = buildUserAgent('Base/1 Kortix+Dev/9.9.9 Tail/2', 'Kortix+Dev', 'KortixDesktop/0.1.0', 'kortix');
    expect(ua).not.toContain('Kortix+Dev/9.9.9');
    expect(ua).toContain('Tail/2');
  });
});
