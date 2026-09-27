---
recorded: 2026-08-25T16:17:53Z
commit: fc05119dd9
---
# A sandbox model failure is a version question before it is a code question

Found 2026-08-25 on the SampleCo box. Native-mode sessions on
`amazon-bedrock/global.openai.gpt-5.6-sol` failed every reasoning stream:
`Type validation failed` on `contentBlockDelta.delta.reasoningContent.redactedContent`.
The first diagnosis blamed an "old SDK in the opencode fork" and planned a
fork patch. `github.com/sst/opencode` redirects to `anomalyco/opencode`; it is
upstream. Upstream had already fixed the crash (anomalyco/opencode#43686 →
#43909, `@ai-sdk/amazon-bedrock` 4.0.112 → 4.0.158, first release v1.18.22).
Our pin in `packages/shared/src/runtime-versions.json` was 1.18.19.

**Rules.**
1. For any failure inside the sandbox runtime, read the pinned OpenCode
   version first, then the dependency pins of that exact tag
   (`raw.githubusercontent.com/anomalyco/opencode/v<tag>/packages/opencode/package.json`)
   and the upstream issue tracker. Diagnose code only after the pin is current.
2. Bump OpenCode through the lockstep sites only: `runtime-versions.json`
   (`opencode` + `opencodeSdk`), `packages/sdk/package.json`
   (`@opencode-ai/sdk`), and the shared Dockerfile goldens. The Dockerfile,
   the runtime-assets manifest, and the plugin pin read the JSON.
3. Audit the upstream diff between the two tags for `packages/opencode/src`
   before merging; record behavior changes that touch the daemon (turn
   termination, retry classification, provider transforms).
4. Do not rebuild sandboxes to propagate. The manifest states the version;
   the daemon converges idle-only and restarts opencode. Verify on one old box:
   `GET <sandbox_url>/global/health` reports the new version and
   `/opt/kortix/runtime-assets-state.json` records it.

*Automation:* `apps/api/src/snapshots/__tests__/config-deps-version.test.ts`
guards the lockstep pins; the shared sandbox goldens fail on a pin drift.

*Incident:* no outage. SampleCo's Bedrock model was unusable in native mode
until PR #6873 (1.18.23) deployed and the box updated with
`kortix self-host update --version dev`.
