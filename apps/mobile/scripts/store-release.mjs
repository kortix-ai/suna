#!/usr/bin/env node
// Releases the app version in app.json to the App Store and Google Play.
//
//   node apps/mobile/scripts/store-release.mjs [--dry-run]
//
// .github/workflows/mobile-store.yml runs it after every Deploy Prod, on the
// released `prod` commit. Per platform, each step only when it is missing:
//   1. build: no finished prod-store build of this version exists;
//   2. submit: the newest store build has no finished EAS submission
//      (Android: Play production track; iOS: App Store Connect);
//   3. iOS review: the App Store version carries that build and goes to App
//      Review, released automatically after approval.
// A run with nothing to do changes nothing. runtimeVersion equals the version,
// so native code that changed after the version's store build needs a version
// bump; the run says so instead of building.
//
// Only released code ships: the run builds, submits or sends to review only a
// build that EAS made from a clean tree at a commit of the checked-out history.
// Any other build of the version is ignored with a warning.
//
// Auth: EXPO_TOKEN only. App Store Connect calls use the API key EAS Submit
// already stores for this app, read from Expo at run time.
import { execFileSync } from 'node:child_process';
import { sign } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { appIdentifier, nativeDiff } from './ota-publish.mjs';

const MOBILE = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROFILE = 'prod-store';
const WHATS_NEW = 'Bug fixes and improvements.';
const BUILD_PROCESSING_TIMEOUT_MS = 60 * 60_000;

/** -1, 0 or 1 for two `major.minor.patch` strings. */
export function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

/**
 * What the run does with an App Store version in this state (appVersionState,
 * or the older appStoreState). `blocked` needs a person: Apple rejected the
 * version or its binary, or a person pulled it from review on purpose; an
 * automatic resubmission would fail again or undo that person's choice.
 */
export function iosStep(state) {
  switch (state) {
    case 'PREPARE_FOR_SUBMISSION':
    case 'READY_FOR_REVIEW':
      return 'submit';
    case 'PENDING_DEVELOPER_RELEASE':
      return 'release';
    case 'WAITING_FOR_REVIEW':
    case 'IN_REVIEW':
    case 'ACCEPTED':
    case 'PENDING_APPLE_RELEASE':
    case 'PROCESSING_FOR_DISTRIBUTION':
    case 'PROCESSING_FOR_APP_STORE':
    case 'WAITING_FOR_EXPORT_COMPLIANCE':
      return 'wait';
    case 'READY_FOR_DISTRIBUTION':
    case 'READY_FOR_SALE':
      return 'live';
    default:
      return 'blocked';
  }
}

/**
 * Build ids EAS finished submitting to the store. An Android build counts only
 * on `track` (eas.json): a build sent to internal testing reached no user.
 */
export function shippedBuildIds(submissions, platform, track) {
  return new Set(
    submissions
      .filter((s) => s.status === 'FINISHED' && s.submittedBuild?.id)
      .filter((s) => platform !== 'android' || s.androidConfig?.track === track)
      .map((s) => s.submittedBuild.id),
  );
}

/**
 * Which store build of the version the run uses (`builds` newest first), and
 * whether it still has to submit it. Android: a build on the production track
 * is the release, so the run never ships a second one. iOS: an uploaded build
 * reaches no user before App Review, which only gets a trusted build.
 * `build: null`: no usable build; the run builds from the released commit.
 * `ignored`: untrusted builds newer than the one used, never shipped by the run.
 */
export function pickBuild({ platform, builds, shipped, trusted }) {
  const released = builds.find((b) => shipped.has(b.id) && (platform === 'android' || trusted(b)));
  const build = released ?? builds.find(trusted) ?? null;
  const newer = build ? builds.slice(0, builds.indexOf(build)) : builds;
  return { build, ship: !released, ignored: newer.filter((b) => !trusted(b) && !shipped.has(b.id)) };
}

const REPO = join(MOBILE, '../..');
/** EAS built it from a clean tree at a commit of the checked-out (released) history. */
function trustedBuild(build) {
  if (build.isGitWorkingTreeDirty !== false || !build.gitCommitHash) return false;
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', build.gitCommitHash, 'HEAD'], { cwd: REPO, stdio: 'ignore' });
    return true;
  } catch {
    return false; // not an ancestor, or a commit this clone does not have
  }
}

const eas = (args) =>
  execFileSync('eas', args, { cwd: MOBILE, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 1 << 28 });
const easJson = (args) => JSON.parse(eas([...args, '--json', '--non-interactive']));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const report = [];
/** `changed`: the run changed something a person should hear about. */
function note(level, text, changed = false) {
  report.push({ level, text, changed });
  console.log(`::${level}::${text}`);
  //codeql[js/http-to-file-access] Non-exploit: internal release tooling run in CI — writes the run's own report lines (including Expo API error text) to GITHUB_STEP_SUMMARY, the CI run's trusted log file.
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `- ${text}\n`);
}

async function expoApi(query, variables) {
  const res = await fetch('https://api.expo.dev/graphql', {
    //codeql[js/file-access-to-http] Non-exploit: internal release tooling run in CI — posts local build metadata as the query/variables to the fixed https://api.expo.dev host; nothing data-derived chooses the request.
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.EXPO_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.errors) throw new Error(`Expo API ${res.status}: ${body.errors?.map((e) => e.message).join('; ') ?? 'no body'}`);
  return body.data;
}

/** Finished store builds of the version, newest first, with their git provenance. */
async function storeBuilds(projectId, platform, appId, version) {
  const data = await expoApi(
    `query ($id: String!, $filter: BuildFilter) { app { byId(appId: $id) {
      builds(offset: 0, limit: 20, filter: $filter) { id appBuildVersion gitCommitHash isGitWorkingTreeDirty }
    } } }`,
    {
      id: projectId,
      filter: { platform: platform.toUpperCase(), status: 'FINISHED', distribution: 'STORE', buildProfile: PROFILE, appVersion: version, appIdentifier: appId },
    },
  );
  return data.app.byId.builds;
}

async function submissions(projectId, platform) {
  const data = await expoApi(
    `query ($id: String!, $platform: AppPlatform!) { app { byId(appId: $id) {
      submissions(offset: 0, limit: 50, filter: { platform: $platform }) { status submittedBuild { id } androidConfig { track } }
    } } }`,
    { id: projectId, platform: platform.toUpperCase() },
  );
  return data.app.byId.submissions;
}

async function ascClient(projectId) {
  const data = await expoApi(
    `query ($id: String!) { app { byId(appId: $id) { iosAppCredentials {
      appStoreConnectApiKeyForSubmissions { keyIdentifier issuerIdentifier keyP8 }
    } } } }`,
    { id: projectId },
  );
  const key = data.app.byId.iosAppCredentials.map((c) => c.appStoreConnectApiKeyForSubmissions).find(Boolean);
  if (!key?.keyP8) throw new Error('EAS stores no App Store Connect API key for submissions (eas credentials -p ios)');
  if (process.env.GITHUB_ACTIONS === 'true') {
    for (const line of key.keyP8.split('\n')) if (line.trim()) console.log(`::add-mask::${line.trim()}`);
  }
  const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  let token = '';
  let expires = 0;
  return async (method, path, body) => {
    const now = Math.floor(Date.now() / 1000);
    if (now > expires - 60) {
      expires = now + 1200;
      const unsigned = `${b64({ alg: 'ES256', kid: key.keyIdentifier, typ: 'JWT' })}.${b64({
        iss: key.issuerIdentifier, iat: now, exp: expires, aud: 'appstoreconnect-v1',
      })}`;
      token = `${unsigned}.${sign('sha256', Buffer.from(unsigned), { key: key.keyP8, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
    }
    const res = await fetch(`https://api.appstoreconnect.apple.com${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok) {
      // A 409 names the real cause in meta.associatedErrors, e.g. a missing
      // age-rating answer: "You must provide a value for the attribute 'socialMedia'".
      const detail = (json.errors ?? []).flatMap((e) => [
        e.detail ?? e.title,
        ...Object.values(e.meta?.associatedErrors ?? {}).flat().map((a) => a.detail ?? a.title),
      ]).join('; ') || text.slice(0, 300);
      throw new Error(`App Store Connect ${method} ${path.split('?')[0]} -> ${res.status}: ${detail}`);
    }
    return json;
  };
}

/** The App Store Connect build for this EAS build, once Apple finished processing it. */
async function processedBuild(asc, appId, version, buildNumber, dryRun) {
  const path = `/v1/builds?filter[app]=${appId}&filter[version]=${buildNumber}&filter[preReleaseVersion.version]=${version}&limit=1`;
  const deadline = Date.now() + BUILD_PROCESSING_TIMEOUT_MS;
  for (;;) {
    const [build] = (await asc('GET', path)).data;
    const state = build?.attributes.processingState;
    if (state === 'VALID') return build;
    if (state === 'FAILED' || state === 'INVALID') throw new Error(`Apple marked iOS build ${version} (${buildNumber}) ${state}`);
    if (dryRun) return null;
    if (Date.now() > deadline) throw new Error(`iOS build ${version} (${buildNumber}) still not processed by Apple after 60 min`);
    console.log(`waiting for Apple to process iOS build ${version} (${buildNumber}): ${state ?? 'not uploaded yet'}`);
    await sleep(30_000);
  }
}

async function releaseIos({ projectId, appId, version, buildNumber, dryRun }) {
  const asc = await ascClient(projectId);
  const versions = (await asc('GET', `/v1/apps/${appId}/appStoreVersions?filter[platform]=IOS&limit=50`)).data;
  const stateOf = (v) => v.attributes.appVersionState ?? v.attributes.appStoreState;
  const newer = versions.find((v) => compareVersions(v.attributes.versionString, version) > 0);
  if (newer) {
    return note('warning', `iOS ${version}: App Store Connect has the higher version ${newer.attributes.versionString} (${stateOf(newer)}). `
      + 'Nothing is submitted until apps/mobile/app.json carries a version above it.');
  }

  // App Store Connect keeps one editable version: an unsubmitted draft of
  // another number is renamed to this version instead of creating a second.
  let target = versions.find((v) => v.attributes.versionString === version);
  const draft = target ? null : versions.find((v) => iosStep(stateOf(v)) === 'submit');
  const step = target ? iosStep(stateOf(target)) : 'submit';
  const label = `iOS ${version} (${buildNumber})`;
  if (step === 'live') return note('notice', `${label} is live on the App Store.`);
  if (step === 'wait') return note('notice', `${label} is with Apple: ${stateOf(target)}.`);
  if (step === 'blocked') return note('warning', `${label} needs a person in App Store Connect: ${stateOf(target)}.`);
  if (step === 'release') {
    if (dryRun) return note('notice', `${label} is approved; would release it now (dry run).`);
    await asc('POST', '/v1/appStoreVersionReleaseRequests', {
      data: { type: 'appStoreVersionReleaseRequests', relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: target.id } } } },
    });
    return note('notice', `${label} was approved and is now released to the App Store.`, true);
  }

  const build = await processedBuild(asc, appId, version, buildNumber, dryRun);
  if (dryRun) {
    const how = target ? `version ${stateOf(target)}` : draft ? `rename draft ${draft.attributes.versionString}` : 'create the version';
    return note('notice', `${label}: would submit for App Review (${how}; build ${build ? 'processed' : 'not processed yet'}) (dry run).`);
  }

  if (target) {
    await asc('PATCH', `/v1/appStoreVersions/${target.id}`, {
      data: { type: 'appStoreVersions', id: target.id, attributes: { releaseType: 'AFTER_APPROVAL' } },
    });
  } else if (draft) {
    target = (await asc('PATCH', `/v1/appStoreVersions/${draft.id}`, {
      data: { type: 'appStoreVersions', id: draft.id, attributes: { versionString: version, releaseType: 'AFTER_APPROVAL' } },
    })).data;
  } else {
    target = (await asc('POST', '/v1/appStoreVersions', {
      data: {
        type: 'appStoreVersions',
        attributes: { platform: 'IOS', versionString: version, releaseType: 'AFTER_APPROVAL' },
        relationships: { app: { data: { type: 'apps', id: appId } } },
      },
    })).data;
  }
  await asc('PATCH', `/v1/appStoreVersions/${target.id}/relationships/build`, { data: { type: 'builds', id: build.id } });
  for (const loc of (await asc('GET', `/v1/appStoreVersions/${target.id}/appStoreVersionLocalizations?limit=50`)).data) {
    if (loc.attributes.whatsNew?.trim()) continue;
    await asc('PATCH', `/v1/appStoreVersionLocalizations/${loc.id}`, {
      data: { type: 'appStoreVersionLocalizations', id: loc.id, attributes: { whatsNew: WHATS_NEW } },
    });
  }

  const drafts = (await asc('GET', `/v1/reviewSubmissions?filter[app]=${appId}&filter[platform]=IOS&filter[state]=READY_FOR_REVIEW&limit=1`)).data;
  const submission = drafts[0] ?? (await asc('POST', '/v1/reviewSubmissions', {
    data: { type: 'reviewSubmissions', attributes: { platform: 'IOS' }, relationships: { app: { data: { type: 'apps', id: appId } } } },
  })).data;
  const items = (await asc('GET', `/v1/reviewSubmissions/${submission.id}/items?include=appStoreVersion&limit=50`)).data;
  if (!items.some((item) => item.relationships?.appStoreVersion?.data?.id === target.id)) {
    await asc('POST', '/v1/reviewSubmissionItems', {
      data: {
        type: 'reviewSubmissionItems',
        relationships: {
          reviewSubmission: { data: { type: 'reviewSubmissions', id: submission.id } },
          appStoreVersion: { data: { type: 'appStoreVersions', id: target.id } },
        },
      },
    });
  }
  await asc('PATCH', `/v1/reviewSubmissions/${submission.id}`, {
    data: { type: 'reviewSubmissions', id: submission.id, attributes: { submitted: true } },
  });
  note('notice', `${label} submitted for App Review; it releases automatically after approval.`, true);
}

async function releasePlatform({ platform, expo, easConfig, dryRun }) {
  const version = expo.version;
  const projectId = expo.extra.eas.projectId;
  const appId = appIdentifier(expo, platform);
  const track = easConfig.submit[PROFILE].android.track;
  const builds = await storeBuilds(projectId, platform, appId, version);
  const shipped = shippedBuildIds(await submissions(projectId, platform), platform, track);
  let { build, ship, ignored } = pickBuild({ platform, builds, shipped, trusted: trustedBuild });
  for (const b of ignored) {
    note('warning', `${platform} ${version} (${b.appBuildVersion}): ignored EAS build ${b.id}, built from `
      + `${b.isGitWorkingTreeDirty === false ? '' : 'uncommitted changes on '}${b.gitCommitHash?.slice(0, 10) ?? 'no commit'}, which is not released code.`);
  }

  if (!build) {
    if (dryRun) return note('notice', `${platform} ${version}: no usable store build; would build, submit${platform === 'ios' ? ' and send to App Review' : ` to the Play ${track} track`} (dry run).`);
    const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: REPO, encoding: 'utf8' }).trim();
    if (dirty) throw new Error(`refusing to build from a checkout with uncommitted changes:\n${dirty.slice(0, 500)}`);
    console.log(`building ${platform} ${version} on EAS (profile ${PROFILE})`);
    [build] = easJson(['build', '--platform', platform, '--profile', PROFILE, '--wait']);
    note('notice', `${platform} ${version} (${build.appBuildVersion}) built: https://expo.dev/accounts/kortix/projects/kortix/builds/${build.id}`, true);
  } else {
    let diff;
    try {
      diff = nativeDiff(easJson(['fingerprint:compare', '--build-id', build.id]), platform);
    } catch {
      diff = [];
    }
    if (diff.length) {
      note('warning', `${platform}: native code changed after the ${version} (${build.appBuildVersion}) store build (${diff.slice(0, 5).join(', ')}). `
        + 'Phones get neither a store build nor OTA updates with it: bump the version (node apps/mobile/scripts/set-version.mjs <next>) on dev.');
    }
  }

  if (ship) {
    if (dryRun) return note('notice', `${platform} ${version} (${build.appBuildVersion}): would submit build ${build.id} (dry run).`);
    eas(['submit', '--platform', platform, '--profile', PROFILE, '--id', build.id, '--non-interactive', '--wait']);
    const where = platform === 'ios' ? 'App Store Connect' : `the Google Play ${track} track`;
    note('notice', `${platform} ${version} (${build.appBuildVersion}) submitted to ${where}.`, true);
  } else if (platform === 'android') {
    note('notice', `android ${version} (${build.appBuildVersion}) is already on the Google Play ${track} track.`);
  }

  if (platform === 'ios') {
    await releaseIos({ projectId, appId: easConfig.submit[PROFILE].ios.ascAppId, version, buildNumber: build.appBuildVersion, dryRun });
  }
}

async function postToSlack() {
  const { SLACK_BOT_TOKEN: token, SLACK_RELEASE_CHANNEL: channel, GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = process.env;
  const changed = report.filter((r) => r.level !== 'notice' || r.changed);
  if (!token || !channel || changed.length === 0) return;
  const run = GITHUB_RUN_ID ? `\n<${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}|Mobile Store run>` : '';
  const icon = { notice: '📱', warning: '⚠️', error: '🛑' };
  const text = changed.map((r) => `${icon[r.level]} ${r.text}`).join('\n') + run;
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8' },
    //codeql[js/file-access-to-http] Non-exploit: internal release tooling run in CI — posts the run's own report to the fixed https://slack.com host; nothing data-derived chooses the request.
    body: JSON.stringify({ channel, text, unfurl_links: false }),
  });
  const body = await res.json().catch(() => ({}));
  if (!body.ok) console.log(`::warning::Slack post failed: ${body.error ?? res.status}`);
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  if (!process.env.EXPO_TOKEN) throw new Error('EXPO_TOKEN is not set');
  const expo = JSON.parse(readFileSync(join(MOBILE, 'app.json'), 'utf8')).expo;
  const easConfig = JSON.parse(readFileSync(join(MOBILE, 'eas.json'), 'utf8'));
  let failed = false;
  // iOS first: Apple's review is the longest wait.
  for (const platform of ['ios', 'android']) {
    try {
      await releasePlatform({ platform, expo, easConfig, dryRun });
    } catch (error) {
      failed = true;
      note('error', `${platform} ${expo.version}: ${error.message}`);
    }
  }
  if (!dryRun) await postToSlack();
  if (failed) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.log(`::error::${error.message}`);
    process.exit(1);
  });
}
