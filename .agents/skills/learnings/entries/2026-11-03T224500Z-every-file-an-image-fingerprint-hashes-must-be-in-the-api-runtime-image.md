---
recorded: 2026-11-03T22:45:00Z
incident_date: 2026-11-03
---
# Every file an image fingerprint hashes must be in the API runtime image, or every session start fails

**Rule:** When a path joins an image fingerprint (`KORTIXD_SHARED_SOURCES`,
`RUNTIME_ARTIFACTS` in `template-runtime-fingerprint.ts`, `metaRuntimeArtifacts`
in `runtime-images.ts`), copy it into the runtime stage of `apps/api/Dockerfile`
in the same change. A copy into the daemon build stage does not count: the API
hashes the files at runtime, from `/app`.

**Trigger surface:** Adding a package or file that the sandbox daemon bundles,
or adding any input to a template fingerprint.

**Incident:** 2026-11-03, dev. From the 22:32 UTC deploy (`28fead82`) every new
session ended `failed` ("The sandbox provider could not start this session").
Sandbox metadata: `ENOENT: no such file or directory, lstat
'/app/packages/voice/src'`. The voice runtime had joined
`KORTIXD_SHARED_SOURCES` (#11633, #11649); the Dockerfile copied it into the
daemon build stage only. Unit tests, typecheck and the image build all passed:
the hash runs only when a session resolves its image. Fixed in #11660.

**Enforcement:** `unit-api-dockerfile-runtime-artifacts.test.ts` ("copies every
input the image fingerprints hash into the runtime stage") fails when any input
of either fingerprint is absent from the runtime stage. Verified both ways: it
names `packages/voice/src` without the fix and passes with it.
