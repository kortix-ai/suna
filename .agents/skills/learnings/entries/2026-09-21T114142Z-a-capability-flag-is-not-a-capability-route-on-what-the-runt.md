---
recorded: 2026-09-21T11:41:42Z
incident_date: 2026-09-21
commit: 22a28c020b
---
# A capability flag is not a capability: route on what the RUNTIME honours, and never pin a turn to a model you have not proven it can run

**Rule.** When code picks a model on the user's behalf, decide from the field
the runtime actually reads, and confirm the pick is runnable before committing
a turn to it. Applies to channel routing, fallback policies and any
"pick a better model" path.

**Incident.** A pasted image in Teams went unanswered for three days across
four distinct causes, each of which looked like the fix for the last. (1) The
session model could not take images, and the gateway's vision reroute is
structurally unreachable because OpenCode strips the image part first. (2) The
obvious flag lied: `glm-5.3-flash` is `attachment: true` with text-only
`modalities`, and OpenCode honours the modalities. (3) `PUT /sessions/:id/model`
answers `applied_live: true` while the OpenCode session keeps its own model, so
only a per-prompt `overrides.model` is honoured. (4) `isModelServableForAccount`
probes with no agent grant, so it approved a `codex/*` model the running agent
could not use and the turn died `Run failed`. Dev-only; no customer impact.

**Enforcer.** `apps/api/src/channels/vision-model.ts` selects on
`modalities.input`, probes every candidate, and fails closed when the agent
grant cannot be resolved; 24 tests pin the exact shapes, including a model that
is in the catalog and refused upstream. Full trace:
`docs/runbooks/teams-channel-testing.md`.
