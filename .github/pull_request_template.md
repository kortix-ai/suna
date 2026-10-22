<!--
  Written for a human reviewer who decides "merge or iterate" without reading the diff.
  Keep only what helps that decision. Delete a section that does not apply; never write "N/A".
  How to write each section: the `create-pr` skill (.agents/skills/create-pr).

  - English only, title and body. Title: `type(scope): <outcome a user notices>`.
  - Every change to `dev`, `staging` or `prod` goes through a pull request (SOC 2 CC8.1).
    A pull request into `dev` runs no CI. The author owns what was verified.
  - This repo is public. Synthetic data only, in text, screenshots and video.
-->

## Summary

<!-- 2–5 sentences. What behavior is different now, for whom (user, admin, agent, operator),
     on which surface (route, screen, CLI command, API), and why. Say what happened before.
     Describe what users see or what the system does, not the code. Link the issue. -->

Closes #

## Demo

<!-- Required. Bold caption first: surface, route, viewport, state, and what to watch for.
     Record with agent-browser on your local stack (the `contributing` skill, step 4), then:
       gh pr create --base dev --body-file output/pr/body.md --attach ./output/pr/demo.mp4
     gh uploads the file and replaces the path below with a video player.
     No user-visible surface: record the terminal, or say in one sentence why a video adds nothing. -->

![Demo](./output/pr/demo.mp4)

## What is affected

<!-- Who and what: users and roles, routes and screens, CLI, SDK surface, data, migrations,
     auth / IAM, billing, secrets, background workers, integrations, self-host.
     Also say what is NOT affected when a reviewer would plausibly worry about it. -->

## Verification

| Command / scenario | Result | What it proves |
| --- | --- | --- |
|  |  |  |

<!-- One row per check that matters. Result: PASS / FAIL / BLOCKED / SKIPPED + reason.
     Name the commit and the environment (worktree stack, dev). Pending CI is not PASS.
     End with 1–2 sentences: why the change works, and what is not verified. -->

## Risks and rollback

<!-- Regressions, migrations, flags, env vars, rollout order, decisions the reviewer must make,
     and how to revert. "None" only when that is true. -->

## Reviewer focus

<!-- 1–3 concrete checks, highest risk first, each with the file or screen to look at. -->

<details>
<summary>Changed files</summary>

<!-- Paths grouped by responsibility, one short line each. -->

</details>
