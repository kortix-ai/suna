#!/usr/bin/env node
// Publishes this commit as an EAS Update to one channel, one platform at a time,
// only when every binary on that channel can run it.
//
//   node apps/mobile/scripts/ota-publish.mjs <dev|production> [--dry-run]
//
// Per platform it SKIPS (exit 0, GitHub warning) when:
//   - no finished build on the channel has this runtimeVersion: nobody would receive it;
//   - the native layer differs from the newest such build of any distribution:
//     the bundle could call native code the binary lacks, so a rebuild is required;
//   - nothing under JS_PATHS changed since the platform's last update on the channel.
// It FAILS (exit 1) when the channel's EXPO_PUBLIC_BACKEND_URL does not answer
// /health: `eas update --environment` bakes that value into the bundle.
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MOBILE = join(dirname(fileURLToPath(import.meta.url)), '..');
// Update channel -> EAS environment its builds use (eas.json `environment`).
const CHANNEL_ENVIRONMENTS = { dev: 'preview', production: 'production' };
const JS_PATHS = ['apps/mobile', 'packages/sdk', 'pnpm-lock.yaml'];
// Fingerprint sources that configure EAS itself and never reach the binary.
const NOT_NATIVE = new Set(['eas.json', '.easignore', '.gitignore']);

// A build's fingerprint is computed in a temporary copy of the project, so its
// paths reach node_modules through `../../../…/Users/<checkout>/node_modules/`;
// a checkout reaches it through `../../node_modules/`. Same module, same version.
export const normalizePaths = (text) => text.replace(/(?:\.\.\/)+(?:[^"/]+\/)*?node_modules\//g, 'node_modules/');

// The fingerprint hashes the whole app config, but another platform's section
// never reaches this platform's binary: an Android package rename is no iOS change.
const FOREIGN_CONFIG = { ios: ['android', 'web'], android: ['ios', 'web'] };

function contentsOf(source, platform) {
  let text = String(source.contents);
  if (source.id === 'expoConfig' && FOREIGN_CONFIG[platform]) {
    const config = JSON.parse(text);
    for (const key of FOREIGN_CONFIG[platform]) delete config[key];
    text = JSON.stringify(config);
  }
  return normalizePaths(text);
}

/** Native sources that differ between two fingerprints (`eas fingerprint:compare --json`) of one platform. */
export function nativeDiff({ fingerprint1, fingerprint2 }, platform) {
  const index = (fingerprint) =>
    new Map(
      fingerprint.sources
        .filter((s) => !NOT_NATIVE.has(s.filePath))
        .map((s) =>
          s.type === 'contents'
            ? [`contents:${s.id}`, contentsOf(s, platform)]
            : [normalizePaths(s.filePath), s.hash ?? ''],
        ),
    );
  const a = index(fingerprint1);
  const b = index(fingerprint2);
  return [...new Set([...a.keys(), ...b.keys()])].filter((key) => a.get(key) !== b.get(key)).sort();
}

const eas = (args) =>
  execFileSync('eas', args, { cwd: MOBILE, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 1 << 28 });
const easJson = (args) => JSON.parse(eas([...args, '--json', '--non-interactive']));
const git = (args) => execFileSync('git', args, { cwd: MOBILE, encoding: 'utf8' }).trim();
const annotate = (level, text) => {
  console.log(`::${level}::${text}`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `- ${text}\n`);
};

function jsChangedSince(commit) {
  try {
    execFileSync('git', ['diff', '--quiet', commit, 'HEAD', '--', ...JS_PATHS], { cwd: join(MOBILE, '../..') });
    return false;
  } catch {
    return true; // exit 1 = changed; anything else (commit not in this clone) = assume changed
  }
}

function lastUpdateCommit(channel, platform, runtime) {
  let groups;
  try {
    groups = easJson(['update:list', '--branch', channel, '--runtime-version', runtime, '--limit', '25']).currentPage;
  } catch {
    return null; // no branch yet
  }
  const group = groups.find((g) => g.platforms.split(/,\s*/).includes(platform));
  if (!group) return null;
  return easJson(['update:view', group.group]).find((u) => u.platform === platform)?.gitCommitHash ?? null;
}

/**
 * The app id this checkout builds for a platform. Only builds of that id are
 * compared: a channel also carries builds of a retired id (the old Android
 * `com.kortix.app` APKs), and their native code never matches today's.
 */
export function appIdentifier(expo, platform) {
  return platform === 'ios' ? expo.ios?.bundleIdentifier : expo.android?.package;
}

/** Why this platform must not publish, or null when it may. */
export function skipReason(channel, platform, runtime) {
  const appId = appIdentifier(JSON.parse(readFileSync(join(MOBILE, 'app.json'), 'utf8')).expo, platform);
  const builds = easJson([
    'build:list', '--channel', channel, '--platform', platform, '--app-identifier', appId,
    '--status', 'finished', '--runtime-version', runtime, '--limit', '50',
  ]);
  if (builds.length === 0) return `no finished ${platform} build of ${appId} on channel "${channel}" has runtime ${runtime}`;

  // The newest build of each distribution (STORE, INTERNAL) is the binary its
  // users run: Apple closes a version once it ships, so a released iOS build is
  // the last store build of its version. Older builds of the same version are
  // earlier test rounds.
  // ponytail: testers still on such an older round can receive an update built
  // for the newest one; a native change bumps the version (set-version.mjs).
  const seen = new Set();
  for (const build of builds) {
    if (seen.has(build.distribution)) continue;
    seen.add(build.distribution);
    let diff;
    try {
      diff = nativeDiff(easJson(['fingerprint:compare', '--build-id', build.id]), platform);
    } catch {
      diff = ['(build has no fingerprint)'];
    }
    if (diff.length) {
      const shown = diff.slice(0, 8).join(', ') + (diff.length > 8 ? `, +${diff.length - 8} more` : '');
      return `native code differs from ${platform} build ${build.appVersion} (${build.appBuildVersion}) ${build.id}: ${shown}. Rebuild required`;
    }
  }

  const last = lastUpdateCommit(channel, platform, runtime);
  if (last && !jsChangedSince(last)) return `nothing under ${JS_PATHS.join(', ')} changed since update commit ${last.slice(0, 10)}`;
  return null;
}

async function main() {
  const [channel, flag] = process.argv.slice(2);
  const environment = CHANNEL_ENVIRONMENTS[channel];
  if (!environment) throw new Error(`usage: ota-publish.mjs <${Object.keys(CHANNEL_ENVIRONMENTS).join('|')}> [--dry-run]`);
  const runtime = JSON.parse(readFileSync(join(MOBILE, 'app.json'), 'utf8')).expo.runtimeVersion;

  const backend = eas(['env:get', environment, '--variable-name', 'EXPO_PUBLIC_BACKEND_URL', '--format', 'short', '--non-interactive'])
    .match(/EXPO_PUBLIC_BACKEND_URL=(\S+)/)?.[1];
  if (!backend) throw new Error(`EAS environment "${environment}" has no EXPO_PUBLIC_BACKEND_URL`);
  const health = await fetch(`${backend}/health`, { signal: AbortSignal.timeout(15_000) }).catch((e) => e);
  if (!health.ok) throw new Error(`${backend}/health did not answer 200 (${health.status ?? health.message}); refusing to bake it into an update`);
  console.log(`channel ${channel} -> environment ${environment}, runtime ${runtime}, backend ${backend} healthy`);

  const sha = git(['rev-parse', 'HEAD']);
  const message = `${git(['log', '-1', '--format=%s'])} (${sha.slice(0, 10)})`;
  for (const platform of ['ios', 'android']) {
    const reason = skipReason(channel, platform, runtime);
    if (reason) {
      annotate('warning', `OTA ${channel}/${platform} skipped: ${reason}.`);
      continue;
    }
    if (flag === '--dry-run') {
      annotate('notice', `OTA ${channel}/${platform} would publish "${message}" (dry run).`);
      continue;
    }
    const [update] = easJson([
      'update', '--channel', channel, '--platform', platform, '--environment', environment, '--message', message,
    ]);
    annotate('notice', `OTA ${channel}/${platform} published runtime ${runtime}: https://expo.dev/accounts/kortix/projects/kortix/updates/${update.group}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.log(`::error::${error.message}`);
    process.exit(1);
  });
}
