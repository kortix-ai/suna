---
recorded: 2026-08-25T18:41:46Z
commit: 952e400c54
---
# A provider's 204 is not a renewal; read the deadline back

*Incident (2026-08-25, SampleCo self-host):* four agent turns died mid-work,
each exactly one hour after the sandbox was created or resumed. The last
assistant message of each was `tokens 0/0/0, parts: []` — an LLM call that was
in flight when the VM froze. Kortix had renewed every box every 20 s
(`[active-turn-renewal]`, `errors:0`; E2B API log: 375 × `POST
/sandboxes/<id>/timeout → 204`). E2B's `KeepAliveFor` clamps every renewal to
the team's `max_length_hours`; the SampleCo team sat on tier `base_v1`
(`max_length_hours = 1`, the upstream migration default) with a matching
`project_limits` row, so `endAt` never moved past `startedAt + 1h` and E2B
paused the box (`sandbox_pause_initiated pause_reason=timeout`).

**Rules.**
1. `renewLifecycle` (`apps/api/src/platform/providers/e2b.ts`) reads `endAt`
   back after `setTimeout` and throws `E2BLifecycleRenewalIgnoredError` when the
   deadline did not advance to within `KORTIX_E2B_RENEWAL_TOLERANCE_MS` of the
   backstop. The reaper and the active-turn renewal loop count it as an error
   and the log names `max_length_hours`.
2. A self-hosted E2B cluster must run its Kortix team at
   `max_length_hours ≥ 24` (`tiers` and `project_limits`; the `team_limits`
   view prefers `project_limits`). The cap is a ceiling on continuous running
   time, not a lifetime: Kortix's own `deadline_at` still stops idle boxes.
3. Existing sandboxes keep the cap they were created with. After raising it,
   pause+resume (or restart) the live boxes; a fresh `POST /timeout` must move
   `endAt`.
4. The fingerprint of this class of failure: an assistant message with
   `tokens 0/0/0` and no parts, created seconds before a provider pause; the
   OpenCode log ends at `llm runtime selected` with no stream line after it.

*Automation:* `apps/api/src/platform/providers/e2b.test.ts` — "refuses to
report a renewal the provider clamped".
