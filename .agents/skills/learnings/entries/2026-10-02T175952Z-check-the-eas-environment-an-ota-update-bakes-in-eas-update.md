---
recorded: 2026-10-02T17:59:52Z
incident_date: 2026-10-02
---
# Check the EAS environment an OTA update bakes in: eas update --environment compiles its EXPO_PUBLIC values over the shell and over eas.json

**Rule:** Before an EAS Update reaches a channel, prove the EAS environment it bakes in serves a live backend. `eas update --environment <env>` passes that environment's variables to Metro over the shell and sets `EXPO_NO_DOTENV=1`. A build profile's `env` block in `eas.json` does not apply to updates. Keep every `EXPO_PUBLIC_*` value in the EAS environment only, so a build and an update of one release compile the same values. Compare a fingerprint against the build only after normalizing paths: EAS computes a build's fingerprint in a temporary copy of the project, so its `node_modules` paths and the autolinking configs differ from any checkout's.

**Trigger surface:** Publishing an EAS Update, editing `.github/workflows/mobile-ota.yml` or `apps/mobile/scripts/ota-publish.mjs`, editing EAS environment variables, editing `apps/mobile/eas.json`, adding or removing a gitignored file under `apps/mobile/ios` or `apps/mobile/android`.

**Incident:** 2026-10-02, near-miss found while wiring the OTA workflow, before any update reached a device. The EAS `production` environment set `EXPO_PUBLIC_BACKEND_URL` to a host that completes TLS and never answers. Store builds had overridden it in the gitignored `eas.json`. A test publish to an unlinked EAS branch compiled that dead host into the Hermes bundle, so the first production OTA would have shown every user "No internet connection". In the same session, two gitignored Xcode workspace files that exist only in some checkouts made a clean checkout's iOS fingerprint differ from a store build's.

**Enforcement:** `apps/mobile/scripts/ota-publish.mjs` fails the run when the environment's `EXPO_PUBLIC_BACKEND_URL` does not answer `/health` with 200, and skips a platform whose normalized native fingerprint differs from the newest build of each distribution. `apps/mobile/scripts/ota-publish.test.ts` covers the path normalization. Still open: no check that the EAS environment equals what the store build compiled.
