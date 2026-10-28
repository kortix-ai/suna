---
name: kortix-capture
description: "Kortix Capture, the standalone recorder app in apps/capture (Rust engine, Swift macOS capture engine, timeline UI, Windows .msi, macOS .pkg, Linux .deb). Load WHENEVER you change anything under apps/capture, the Capture workflows (capture-build.yml, capture.yml, the build-capture and attach-capture jobs of deploy-prod.yml), the /download/capture route, or the Capture installers; when you cut or debug a Capture release; and when you need the Kortix Capture bucket format (schema 2) or the app's behavior."
---

# Kortix Capture

The app lives in `apps/capture` and ships with every Kortix release under the
same version. The server side (ingest, devices, policy, the web area) lives in
`apps/api/src/capture` and `apps/web/src/features/capture`.

## Read first

- `references/release-runbook.md`: build, verify, publish, update manifest,
  secrets, human steps. Load it for any CI/CD or release question.
- `references/app-behavior.md`: product behavior, enrollment, installers,
  sync, privacy. The feature map.
- `references/self-host.md`: Capture sync on `kortix self-host` (the bundled
  store, why it sits on the API origin, upgrade, proof). Load it for a 503
  `capture_credentials_unavailable` on a self-hosted instance.
- `references/capture-format.md`: the bucket format, the app's only contract
  with any cloud. JSON Schemas are in `apps/capture/schemas/`, the fixture
  bucket in `apps/capture/fixtures/capture-format-v2/`. The API tests, the
  CAP flows and the SDK rules test read those files directly. There is no
  second copy.

## Rules

- Rust tests run in `.github/workflows/capture-build.yml`, not in `pnpm test`.
  `apps/capture/package.json` runs only the fast UI tests (`node --test`).
- Never install or launch the app on a development Mac. The installers register
  a root service and ask for Screen Recording. The workflow does it on runners.
- Run recorder tests with a scratch `KORTIX_CAPTURE_DIR`.
- A format change updates the schemas, the fixtures
  (`KORTIX_CAPTURE_WRITE_FIXTURES=1 cargo test --test capture_format`), the API
  reader (`apps/api/src/capture/format.ts`) and the CAP flows in one branch.
- License: Apache License 2.0 (the root `LICENSE`). Third-party notices are in
  `apps/capture/THIRD_PARTY_NOTICES`. Update them when a dependency with other
  terms is added.
- Copy and comments: short, plain, one idea per sentence.
