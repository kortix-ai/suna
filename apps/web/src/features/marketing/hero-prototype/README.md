# Hero A — Rightfit layout prototype

This development-only experiment reproduces Rightfit's navbar and hero composition with Kortix content. The rejected Orbit walkthrough is preserved in commit `3c5e32b173`.

## Review

```sh
WEB_PORT=17900 pnpm --dir apps/web dev
```

- Prototype: http://localhost:17900/?variant=hero-a
- Baseline: http://localhost:17900/?variant=current
- Optional comparison dock: append `&compare=1` to either URL.
- Production builds and other routes retain the original navbar and hero.
- All homepage sections after the hero remain unchanged.

## Composition

The live reference was measured at https://www.rightfit.so/ on 2026-09-21. It uses a 1152px content width, 56px navbar, 240px desktop hero top padding, 60px/72px heading, 48px column gap, and 40px introduction-to-frame gap. These scoped CSS dimensions follow the user's explicit request to copy the reference layout. They are deliberate exceptions to token spacing. Color and UI controls retain Kortix tokens.

The left column holds a two-line headline. The right column holds right-aligned copy and two actions. Products, Resources, and Blog occupy the navbar center. Request demo and Get started appear on the right in both places.

The 16:10 media frame has a top tab strip, wallpaper, and an inset product screen. It uses Kortix's existing Neuro wallpaper, not Rightfit's floral artwork. Web, CLI, Slack, MS Teams, Email, Mobile, and API / SDK reuse the existing marketing surface components. Web and CLI are recordings. Other surfaces contain local demonstrations and their existing docs links. Only the active panel mounts.

Below 1024px, the introduction stacks. Below 640px, the navbar uses an accessible dropdown. Tabs scroll horizontally and support arrow keys. Video panels retain their complete aspect ratio on phones; interactive panels retain 400px of height. Reduced motion uses the existing static recording posters.

Request demo opens the existing modal. Get started uses `/auth` for visitors and the existing latest-project destination for signed-in users. The prototype creates no backend writes during surface selection. The demo form is not submitted during verification.

## Verification and limits

Browser evidence is in `output/playwright/rightfit/` (local review artifacts, not production assets). Chromium checks cover all seven panels, dropdowns, modal dismissal, tab keyboard navigation, URL persistence, baseline restoration, both themes, and 390/768/1280/1440px widths. The responsive pass additionally checks panel height to catch collapsed media.

The brand audit excludes marketing files. Manual review is required; the reference geometry exception is described above. Shared surface components retain existing styling and one existing `set-state-in-effect` lint warning.

The web typecheck reports the 15 existing test.each/implicit-any errors documented in AGENTS.md. Native Electron, authenticated destination navigation, actual browser-menu zoom, and production deployment are not verified. CSS zoom is checked at 200%. Existing homepage sections can emit hydration/WebGPU errors; these are outside this prototype's changed components.

Stop at visual review. Do not start another section or merge to main without the user's direction.
