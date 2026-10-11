# Mobile Build Guide

## Setup
```bash
pnpm install -g eas-cli
eas login
```

## Android Development Setup

**Default workflow (cloud build - recommended):**
```bash
cd apps/mobile
pnpm run android:setup
pnpm run android:build
pnpm run android:dev
```

## iOS Development Setup
```bash
cd apps/mobile
npx expo run:ios
```

## Build profiles (`eas.json`)

Every profile name states its backend and its artifact. Every profile increments
the build number (EAS keeps it remotely).

| Profile | Backend | EAS environment | Update channel | Artifact |
|---|---|---|---|---|
| `prod-store` | `api.kortix.com` | `production` | `production` | App Store / Play (AAB) |
| `prod-apk` | `api.kortix.com` | `production` | `production` | installable APK |
| `dev-store` | `dev-api.kortix.com` | `preview` | `dev` | TestFlight / Play internal (AAB) |
| `dev-apk` | `dev-api.kortix.com` | `preview` | `dev` | installable APK |
| `development` | local `.env` | — | `development` | dev client |

`EXPO_PUBLIC_*` values come from the EAS environment only, for builds and for
OTA updates alike: `eas env:list production`. Change them there, never in
`eas.json`, or a build and an update of the same release disagree.

## Release a store version

The version changes once per store release. The build number changes on every
build. `runtimeVersion` equals the version, so an OTA update only reaches
binaries built from the same release.

```bash
cd apps/mobile
node scripts/set-version.mjs 1.4.4          # writes all 6 copies (app.json, ios/, android/)
eas build --profile prod-store --platform ios --auto-submit       # TestFlight
eas build --profile prod-store --platform android --auto-submit   # Play internal track
git tag mobile-v1.4.4 && git push origin mobile-v1.4.4            # the submitted commit
```

`scripts/set-version.test.ts` fails when the copies disagree. A native change
(new native module, permission, Expo SDK, anything under `ios/` or `android/`)
needs a new version and a store build: OTA cannot ship it.

## OTA updates

`.github/workflows/mobile-ota.yml` publishes the JS/TS bundle with
`scripts/ota-publish.mjs`:

| Event | Channel | Reaches |
|---|---|---|
| `Deploy Prod` succeeded (each production release) | `production` | `prod-store`, `prod-apk` builds |
| Actions → Mobile OTA → Run workflow, channel `dev` | `dev` | `dev-store`, `dev-apk` builds |
| Actions → Mobile OTA → Run workflow, channel `production` | `production` | a re-run of the released `prod` branch, whichever branch the button runs from (`dry_run` publishes nothing) |

A push to `dev` publishes nothing: the `Tests` lanes, the cheap guards, and
path-gated infra run on `dev`.

Per platform the script **skips** (warning on the run) when:
1. no finished build on the channel has the current `runtimeVersion`;
2. the native fingerprint differs from the newest build of each distribution
   (store, internal): the run names the differing sources and says
   "Rebuild required";
3. nothing under `apps/mobile`, `packages/sdk` or `pnpm-lock.yaml` changed since
   the channel's last update.

It **fails** when the environment's `EXPO_PUBLIC_BACKEND_URL` does not answer
`/health` with 200, because that URL is compiled into the bundle.

A device downloads an update in the background on launch and runs it on the
next launch.

### Verify an update

```bash
eas update:list --branch production --limit 5            # what was published, with its commit
eas update:insights <group-id>                           # launches, crashes, unique users
eas fingerprint:compare --build-id <build-id>            # why a platform was skipped
```

On a device: open the app, close it, open it again; the change is visible on the
second launch.

### Roll back a bad update

1. Find the last good update group: `eas update:list --branch production --limit 10`.
2. Serve it again (new update id, same bundle):
   ```bash
   eas update:republish --group <good-group-id> --message "Roll back <bad-group-id>"
   ```
   With no good update for this runtime, send devices back to the bundle inside
   the binary:
   ```bash
   eas update:roll-back-to-embedded --channel production --platform all --runtime-version <runtime> \
     --message "Roll back <bad-group-id>"
   ```
3. Confirm: the new entry is on top of `eas update:list --branch production`,
   and a device shows the old behavior on its second launch.
4. Fix forward on `dev`. The next production release publishes again.
