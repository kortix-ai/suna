---
recorded: 2026-09-18T18:45:00Z
incident_date: 2026-09-18
commit: e7f107f677
---
# A popover asserted across a viewport or theme change needs the whole group retried

**When:** a Playwright journey holds a Radix popover, dropdown, or select open
while it changes `setViewportSize` or the theme class. Those layout changes
dismiss it, asynchronously — so a single `isVisible()` guard reads `true` while
the close is in flight, the reopen is skipped, and ANY later assertion lands on
a closed panel. Guarding one assertion only moves the failure.

**Near-miss:** `30-pooled-provider-secrets.spec.ts:99` failed locally on main at
two different assertions on two runs — `Save changes` at the 1440 -> 390 shrink
on the first dark iteration (all three light sizes passed), then `Unsaved key
changes` one assertion later under two workers. Found while proving the staging
failure of the same test was an artifact; it would have failed the next gate on
a correctly deployed staging.

**Rule:** re-establish the panel by its OWN control, never by the container's
visibility, and wrap the per-size assertion group in `expect(...).toPass()` so a
dismissal costs a retry. Weaken no assertion inside it. A scan or screenshot
that targets the panel by selector must separately require it to be open, or an
empty result reads as a pass. Extends the 2026-09-14 entry "Assert settled
dialog geometry before capturing a responsive screenshot".

**Enforcement:** the retried group in that spec; verified `4 passed` on two
consecutive two-worker runs, failing on both runs before it.
