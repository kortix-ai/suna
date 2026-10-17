---
recorded: 2026-10-15T21:06:28Z
incident_date: 2026-10-15
---
# Sync a mobile icon twin's attribute syntax when the web source changes form: the pin reads source text

**Rule:** When you refresh an icon under `apps/web/src/features/icon/icons/`
that has a mobile twin under `apps/mobile/components/icons/`, diff the two
sources after the change, not only the rendered pixels. The twin pins compare
source text: an attribute that moves from a quoted literal
(`fill="url(#a)"`) to a JSX expression (`fill={`url(#${uid}a)`}`) changes what
the pin's regex counts on each side, and the mobile twin must take the same
form (its ids stay prefixed, so the pin's normalizer can match them).

**Trigger surface:** Editing a web icon that a `apps/mobile/components/icons/*-icon.test.ts`
pins (`teams-icon.test.ts`, `slack-icon.test.ts`), especially a collision fix
that introduces `useId` ids or rewrites attribute values as expressions.

**Incident:** 2026-10-15, PR #9982 rewrote the Microsoft Teams mark's twelve
gradient fills from quoted literals to template literals (per-instance `useId`
ids, fixing a blank-tile collision on the Channels tab). The mobile twin kept
quoted `fill="url(#teams-…)"`, so `apps/mobile/components/icons/teams-icon.test.ts`
("is the web mark, element for element") counted 12 fill entries on the mobile
side and 0 on the web side and went red at the trunk. The red `packages` lane
blocked every attestation-gated PR until KRTX-2454 synced the twin.

**Enforcement:** `apps/mobile/components/icons/teams-icon.test.ts` — the
element-for-element pin goes red at the trunk the moment the two sides'
attribute forms diverge; the `packages` lane runs it on every push to `dev`.
