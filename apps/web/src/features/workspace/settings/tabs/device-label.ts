/**
 * Name a signed-in device from the User-Agent it signed in with: "Chrome" on
 * "macOS". First match wins, so the browsers that also claim "Chrome" or
 * "Safari" in their UA come first. A UA that is not a browser (a script, the
 * CLI) keeps its product token ("Bun"); an empty one names nothing and the
 * row falls back to "Unknown device".
 */
const BROWSERS: [RegExp, string][] = [
  [/Electron\//, 'Kortix desktop'],
  [/Edg(A|iOS)?\//, 'Edge'],
  [/OPR\//, 'Opera'],
  [/(Firefox|FxiOS)\//, 'Firefox'],
  [/(Chrome|CriOS)\//, 'Chrome'],
  [/Safari\//, 'Safari'],
];

const SYSTEMS: [RegExp, string][] = [
  [/iPhone|iPod/, 'iOS'],
  [/iPad/, 'iPadOS'],
  [/Android/, 'Android'],
  [/CrOS/, 'ChromeOS'],
  [/Mac OS X|Macintosh/, 'macOS'],
  [/Windows/, 'Windows'],
  [/Linux/, 'Linux'],
];

export function describeUserAgent(userAgent: string | null): {
  browser: string | null;
  os: string | null;
  mobile: boolean;
} {
  const ua = userAgent ?? '';
  const browser =
    BROWSERS.find(([pattern]) => pattern.test(ua))?.[1] ?? (/^([\w.-]+)\//.exec(ua)?.[1] || null);
  const os = SYSTEMS.find(([pattern]) => pattern.test(ua))?.[1] ?? null;
  return { browser, os, mobile: os === 'iOS' || os === 'Android' };
}
