#!/usr/bin/env node
// Sets the app version in every file a native build or EAS Update reads it from.
//
//   node apps/mobile/scripts/set-version.mjs 1.4.4
//
// The version changes once per store release, never per build: EAS increments
// the build number on every build. runtimeVersion follows the version, so an
// OTA update only reaches binaries built from the same release. `ios/` and
// `android/` are committed (no prebuild), so app.json alone changes nothing in
// a build: each native copy is written here too.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MOBILE = join(dirname(fileURLToPath(import.meta.url)), '..');

// [file, pattern]: group 1 is the text in front of the version, group 2 the version.
/** @type {Array<[string, RegExp]>} */
export const VERSION_SITES = [
  ['app.json', /("version": ")([^"]+)/g],
  ['app.json', /("runtimeVersion": ")([^"]+)/g],
  ['ios/Kortix/Info.plist', /(<key>CFBundleShortVersionString<\/key>\s*<string>)([^<]+)/g],
  ['ios/Kortix/Supporting/Expo.plist', /(<key>EXUpdatesRuntimeVersion<\/key>\s*<string>)([^<]+)/g],
  // Not MARKETING_VERSION in project.pbxproj: Info.plist holds the literal, so
  // that build setting never reaches the app.
  ['android/app/build.gradle', /(versionName ")([^"]+)/g],
  ['android/app/src/main/res/values/strings.xml', /(<string name="expo_runtime_version">)([^<]+)/g],
];

export function readVersions(root = MOBILE) {
  return VERSION_SITES.flatMap(([file, re]) =>
    [...readFileSync(join(root, file), 'utf8').matchAll(re)].map((m) => ({ file, version: m[2] })),
  );
}

export function setVersion(version, root = MOBILE) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`expected MAJOR.MINOR.PATCH, got "${version}"`);
  for (const [file, re] of VERSION_SITES) {
    const path = join(root, file);
    writeFileSync(path, readFileSync(path, 'utf8').replace(re, `$1${version}`));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  setVersion(process.argv[2]);
  for (const { file, version } of readVersions()) console.log(`${version}  ${file}`);
}
