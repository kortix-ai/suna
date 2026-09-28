---
recorded: 2026-08-29T14:20:38Z
commit: c6a41249f9
---
# Release assertions must follow the named data source, not an obsolete availability bit

- **Incident (2026-08-29, v0.13.7 release QA):** `SESS-24` failed two exact-SHA
  staging attempts after a stopped session returned `available:true`. The API
  was correct. `buildSessionTranscriptDigest()` intentionally serves the
  durable transcript mirror for a stopped session. Its unit test already pinned
  `source:"mirror"`. The end-to-end contract still expected the deleted
  `available:false` behavior from before the mirror existed.
- **Rule:** when a response can come from live, mirror, or no source, assert the
  `source` discriminator and the required content. Do not use `available` alone
  as a proxy for runtime state. Update the natural-language contract in the same
  change that adds or removes a source.
- **Enforcement:** `SESS-24` now stops the sandbox, requires
  `available:true` plus `source:"mirror"`, and verifies session isolation in the
  mirrored content. `session-transcript.test.ts` separately pins the stopped
  session mirror and the no-mirror `available:false` path.
