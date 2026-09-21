# Hero A — interactive product prototype

Question: does a readable Kortix task and artifact explain the product at first glance?

Status: first prototype, awaiting Jay's visual review. Do not promote this experiment directly to production.

## Run and compare

From this worktree:

```sh
WEB_PORT=17900 pnpm --dir apps/web dev
```

- Hero A: http://localhost:17900/?variant=hero-a
- Current hero: http://localhost:17900/?variant=current
- Without a recognized variant, the existing hero renders.
- Production builds always render the existing hero. The comparison module is development-only.
- The floating comparison bar supports arrows while focused. Dismiss it with its close button for an unobstructed review; reload to restore it.

The existing header, model/connector strip, and all later sections stay in place. This iteration adds only Hero A.

## Content and controls

Orbit is a fictional collaboration product. The agent's task, sources, and artifact are local fixtures. No model, sandbox, deployment, account creation, or persistence runs from the example.

The completed task appears first. The walkthrough opens Brief, then Build, then Preview. Both Markdown source buttons open inline details. Escape closes a source and restores focus. The device tabs reflow the HTML artifact. Expansion uses the shared Modal. Its demo signup action explains that no account was created. Reset restores the completed desktop example.

The real Kortix Get started link retains the anonymous/authenticated destination logic. Prototype interactions do not emit signup analytics.

## Design decisions

- Rightfit-inspired split introduction and full-width product frame.
- Desktop: 7/5 introduction and 5/7 workspace split.
- Tablet: stacked workspace panes.
- Phone: Task/Preview tabs, with Preview selected first.
- Roobert, semantic colors, existing controls, and Kortix spacing tokens.
- No autonomous playback. Reduced motion removes the local transition.
- Retain source content, task stages, and product preview as separate concepts.

## Review checkpoint

Review hierarchy, workspace density, artifact quality, and phone composition. Revise Hero A before building another variation or another section. Archive the prototype on its branch when a design wins; integrate the selected design separately with production localization, analytics, and regression coverage.

## Verification

See local artifacts in `output/playwright/hero/` and the verification summary beside them. Screenshot and recording files are review evidence, not production assets.

The full web typecheck has 15 pre-existing `test.each`/implicit-any errors in three test files, as documented in AGENTS.md. The prototype's touched paths have no type errors. Native Electron, signed-in destination navigation, and production rollout are outside this prototype review and are not claimed as verified.
