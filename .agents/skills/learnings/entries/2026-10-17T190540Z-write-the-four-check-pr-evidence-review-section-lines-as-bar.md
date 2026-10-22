---
recorded: 2026-10-17T19:05:40Z
incident_date: 2026-10-17
---
# Write the four check-pr-evidence Review-section lines as bare lines, never bullets

**Rule:** In a kortix-ai/suna PR body's `## Review in 60 seconds` section, write `**Risk:** <low|medium|high> — <why>`, `**Verified:** <commands and results>`, `No demo video: <reason>` and `suna-skills: <skills loaded>` as their own bare lines. A bullet like `- **Risk:** low …` does not match the gate's line-start anchors (`/^\s*\*\*Risk:\*\*/` and friends): the section must not start the line with a hyphen. The bullets for What/Evidence stay bullets.

**Trigger surface:** Every factory worker PR (software-factory item 14) writing the PR body template before `check-pr-evidence --pr <n>`.

**Incident:** 2026-10-17, PR 10153 (fix mobile save-to-device, KRTX-2481): the body carried all four lines as bullets; the gate failed four checks at once (no-video reason, Risk, Verified, suna-skills "missing") although all four were present, costing a debug round and one body rewrite. The gate's failure text says "missing" for lines that are in the section — nothing names the line-start anchor.

**Enforcement:** `check-pr-evidence` itself: it FAILs those four checks until the lines are bare, and the only cost is the rewrite loop; the learning removes the loop. Run `check-pr-evidence --body-file <body> --files-file <files>` locally before `gh pr create` to catch it without a live PR.
