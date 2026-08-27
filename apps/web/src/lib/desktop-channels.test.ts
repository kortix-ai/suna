import { describe, expect, it } from 'bun:test';
import { createRequire } from 'node:module';
import path from 'node:path';

import {
  DEFAULT_DESKTOP_SCHEME,
  DESKTOP_SCHEMES,
  desktopChannelForHost,
  desktopReleaseTag,
  resolveDesktopScheme,
} from './desktop-channels';

describe('desktopChannelForHost', () => {
  it('maps the dev and staging hosts to their channels', () => {
    expect(desktopChannelForHost('dev.kortix.com')).toBe('dev');
    expect(desktopChannelForHost('staging.kortix.com')).toBe('staging');
  });

  it('ignores case and a port suffix', () => {
    expect(desktopChannelForHost('DEV.KORTIX.COM')).toBe('dev');
    expect(desktopChannelForHost('staging.kortix.com:443')).toBe('staging');
  });

  // A self-hoster's /download must hand out the released installer, never a
  // mutable dev prerelease. Anything unrecognised therefore falls to stable.
  it('treats every other host as stable', () => {
    const hosts = [
      'kortix.com',
      'www.kortix.com',
      'localhost',
      'kortix.example.com',
      'suna-git-branch.vercel.app',
      '',
      null,
      undefined,
    ];
    for (const host of hosts) expect(desktopChannelForHost(host)).toBe('stable');
  });

  // A lookalike host must not be promoted into a prerelease channel.
  it('does not match a subdomain of the dev host', () => {
    expect(desktopChannelForHost('evil.dev.kortix.com')).toBe('stable');
    expect(desktopChannelForHost('dev.kortix.com.attacker.test')).toBe('stable');
  });
});

describe('resolveDesktopScheme', () => {
  it('accepts every known scheme', () => {
    for (const scheme of Object.values(DESKTOP_SCHEMES)) {
      expect(resolveDesktopScheme(scheme)).toBe(scheme);
    }
  });

  // The param rides in on a public callback URL, so anything off the allowlist
  // degrades to kortix:// rather than dictating an arbitrary protocol.
  it('rejects anything off the allowlist and falls back to the stable scheme', () => {
    const raws = ['javascript', 'file', 'kortix-evil', 'KORTIX', '', null, undefined];
    for (const raw of raws) expect(resolveDesktopScheme(raw)).toBe('kortix');
  });

  it('defaults to the scheme every pre-existing build registers', () => {
    expect(DEFAULT_DESKTOP_SCHEME).toBe('kortix');
  });
});

describe('desktopReleaseTag', () => {
  // Stable has no fixed tag — it ships in whatever vX.Y.Z is current.
  it('names no tag for stable', () => {
    expect(desktopReleaseTag('stable')).toBeNull();
  });

  // These strings are the contract with desktop.yml's publish job.
  it('names the mutable prerelease tags for dev and staging', () => {
    expect(desktopReleaseTag('dev')).toBe('desktop-dev-latest');
    expect(desktopReleaseTag('staging')).toBe('desktop-staging-latest');
  });
});

// This file and apps/desktop-electron/src/channel.js sit on opposite sides of a
// package boundary and cannot import each other, so the schemes are written out
// twice. This test is what stops the two copies from drifting: rename a scheme
// in the shell and the web build fails here rather than silently emitting a
// deep link no installed app answers.
describe('agreement with the desktop shell', () => {
  const shellPath = path.resolve(
    import.meta.dir,
    '../../../desktop-electron/src/channel.js',
  );
  const { CHANNELS } = createRequire(import.meta.url)(shellPath) as {
    CHANNELS: Record<string, { scheme: string }>;
  };

  it('covers exactly the shell\'s channels', () => {
    expect(Object.keys(DESKTOP_SCHEMES).sort()).toEqual(Object.keys(CHANNELS).sort());
  });

  it("uses the shell's scheme for every channel", () => {
    for (const channel of Object.keys(DESKTOP_SCHEMES) as (keyof typeof DESKTOP_SCHEMES)[]) {
      expect(DESKTOP_SCHEMES[channel]).toBe(CHANNELS[channel].scheme);
    }
  });

});
