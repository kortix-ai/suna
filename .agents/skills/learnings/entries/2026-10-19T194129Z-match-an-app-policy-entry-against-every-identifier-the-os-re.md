---
recorded: 2026-10-19T194129
incident_date: 2026-10-19
---
# Match an app policy entry against every identifier the OS reports, and test it on a packaged Windows app

**Rule:** Compare an app list entry (exclusion, Record only, own apps) with every identifier of the app through `memory::exclusions::app_matches` (Swift: `appMatches`), never with one stored id. Add a vector to `apps/capture/fixtures/capture-format-v2/apps.json` for every new app class. A reader of capture frames keeps `inactive` frames: "no input for 5 s" is not "nothing on screen".

**Trigger surface:** Changing how Capture names an app (`bundle_id`, `aliases` in `capture_engine/win.rs`, `linux.rs`, `CaptureEngine.swift`), any list check in the engine or `memory::exclusions`, or a timeline query in `apps/api/src/capture/reads.ts`.

**Incident:** 2026-10-19, dev build 0.14.3-dev.64. An account excluded `notepad.exe`. Windows 10 hid Notepad; Windows 11 recorded it, because its Notepad is a packaged app whose `bundle_id` is the AppUserModelID. Every MSIX/Store app was affected, for exclusion and for Record only. Separately, an unattended Windows 11 PC showed frames but no timeline runs: `timelineRuns` dropped `inactive` frames. Fixed in #10299.

**Enforcement:** `apps_match_by_the_shared_vectors` (Rust, all OSes in capture-build.yml, Windows included since #10299) and `the_engine_matches_apps_by_the_shared_vectors` (macOS Swift engine) go red on a rule change; `integration-capture.test.ts` asserts inactive frames keep their runs.
