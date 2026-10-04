# Kortix films — launch and product videos as code

A Kortix film is a Next.js route, like a deck. Every frame is a pure function of
the frame number. The same React tree plays live in the browser and renders to
an MP4, frame by frame, through headless Chromium and ffmpeg. There is no video
editor, no timeline file, and no second design system.

## Why this shape

The 2026 launch-video pattern is "the model writes code, a renderer paints the
frames" — Remotion or HyperFrames driven by Claude Code. The quality levers in
every good example are the same:

1. **Brand fidelity over novelty.** Tokens, type, marks, and UI come from the
   product itself, not from a recreation.
2. **A storyboard before code.** Beats with a claim, a visual, and a timing.
3. **Motion rules, chosen once.** Opacity and transform never share a curve.
   Transitions are chosen by tone, not for variety. One accent, reserved for
   the payoff.
4. **Sound locked to picture.** Cuts land on the bar.
5. **Every frame is deterministic.** A frame renders the same on every run.

Kortix already has the design system, the fonts, the marks, the product UI, and
a public, `noindex` route tree (`/presentations`) built to be recorded. A film
lives there and imports all of it. Remotion would duplicate the token pipeline
and needs a paid company licence. HyperFrames would duplicate the components.
The engine here is ~400 lines and has no dependency beyond what `apps/web` and
the repo test runner already ship (Next.js, Playwright, ffmpeg).

## Where everything is

```
apps/web/src/app/[locale]/presentations/film/
  [film]/page.tsx        server route: static params + noindex metadata
  [film]/film-client.tsx slug → film; player, or render mode with ?render=1
  registry.ts            FILMS — the one list to edit to add a film
  engine/time.ts         FPS, bar grid, easings, interp, spring, stagger
  engine/film.tsx        Stage, Seq, useFrame, Player, render hook
  films/launch/*         the launch film: scenes, beats, cues
apps/web/scripts/film/
  render.ts              frames → MP4 (Playwright + Chrome + ffmpeg)
  soundtrack.py          synthesized score + SFX at cue frames → audio.wav
  sfx/                   ElevenLabs sound effects, fetched once
```

Output lands in the gitignored `output/film/<slug>/` at the repo root.

## The grid

- Stage: **1280 × 720 CSS px**, always dark (`.dark` on the stage root).
  Rendered at device scale 1.5 → **1920 × 1080**, or 3 → 3840 × 2160.
- **60 fps.** Score at **120 BPM, 4/4**. One beat = 30 frames. One bar = 120
  frames = 2 s. Every scene starts and ends on a bar line.
- A scene is a `Seq` with `from` and `dur` in frames, built with `bars(n)`.

## Motion rules

The film is a marketing surface with a time axis. Color, type, spacing, and
radius follow `kortix-brand` with no exception. Motion uses the
marketing column, stretched for a film:

| Rule | Value |
| --- | --- |
| Enter | opacity over 12–18 frames, `outQuad`; transform over 3× that, `outExpo` |
| Move on screen | `inOutCubic` |
| `ease-in` | never |
| Spring | critically damped, bounce 0 |
| Enter scale floor | 0.92 — never from 0 |
| Blur | only as a bridge between two states, 8px → 0 |
| Stagger | `pow(i, 0.8) × base`, compressing, never marching |
| Child follow-through | 2–3 frames behind its parent |
| Camera | a slow push (scale 1 → 1.04) under every scene |
| Accent | `kortix-green`, only where the product itself shows green: merged, running |
| Transitions | *push* between similar scenes, *settle* (shrink + gap frame + land) across a tonal jump |
| Scene arrival | never blank — a scene's clock starts 12–20 frames before its cut |

## The launch film — storyboard

64 s, 32 bars, 11 beats. Every claim is a sanctioned line from the `kortix-brand`
kit (`positioning.md`, `concepts.md`, `claims.md`). No invented metric. `Northwind` is the placeholder project.

| # | Bars | Time | On screen | Motion | Sound |
| --- | --- | --- | --- | --- | --- |
| 1 | 0–2 | 0–6 s | "The models got good." → "They still wake up with no memory of you." → "A toy." / "Or a cage." | word rise, blur-bridge swap, split | pad, typing ticks |
| 2 | 3–4 | 6–10 s | The Kortix mark lands. Lockup. "The open-source AI Operating System." | settle across the black gap; mark orbit | riser → impact on bar 3 |
| 3 | 5–7 | 10–16 s | "Your company is a git repository." Northwind tree + `kortix.yaml` | lines type in, compressing stagger; panel tilt | groove starts |
| 4 | 8–10 | 16–22 s | "Every session gets its own computer." Prompt → boot → clone → branch → tests pass | status rows resolve one per beat | ticks on each row |
| 5 | 11–13 | 22–28 s | "Thousands of sessions. One config." One card becomes a field of isolated sessions | camera pull-back, grid doubling per beat | whoosh |
| 6 | 14–16 | 28–34 s | "Work lands through a change request you approve." Diff, Approve, **Merged** | cursor press 0.96, green payoff, branch merges into `main` | click, chime |
| 7 | 17–19 | 34–40 s | "3,000+ apps. Any model. Your keys." App wall around the mark, then model row | tiles from the centre outward | whoosh |
| 8 | 20–22 | 40–46 s | "Where your team already works." Web, CLI, Slack | surface tabs switch on the beat | ticks |
| 9 | 23–24 | 46–50 s | "Triggers fire at night. It improves itself." cron → session → change request on its own skill | clock chip, second green payoff | chime |
| 10 | 25–28 | 50–58 s | "Open source. Yours down to the metal." `kortix init` · `kortix ship` · Kortix Cloud / your servers / on-prem · 20,000+ GitHub stars | terminal type, chips rise | breakdown, filter sweep, lift |
| 11 | 29–31 | 58–64 s | Brandmark, tagline, `kortix.com` | hold still, fade to black | final chord, tail |

## Sound

- **Score:** synthesized by `score.py` from the bar grid: sub, kick, bass,
  pad chords, an arpeggio, and a riser. The ElevenLabs Music API needs a paid
  plan (`402 paid_plan_required` on the free key), so the score is generated
  locally and is fully reproducible.
- **Sound effects:** ElevenLabs `POST /v1/sound-generation`, fetched once, kept
  next to the mixer.
- **Cues:** the film exports `cues` (frame, effect, gain). `render.ts` writes
  them to JSON, and `soundtrack.py mix` places each effect on its frame, then
  normalizes to −14 LUFS with a −1.5 dBTP ceiling.
- The film must work with the sound off: every claim is on screen.

## Commands

```bash
# live preview, and one frame (worktree web port)
open http://localhost:<web>/presentations/film/launch
open "http://localhost:<web>/presentations/film/launch?frame=1800"

# sound effects: once, then committed under scripts/film/sfx/
ELEVENLABS_API_KEY=… python3 apps/web/scripts/film/soundtrack.py fetch-sfx

# soundtrack only (also writes apps/web/public/film/<slug>.m4a for live playback)
bun apps/web/scripts/film/render.ts launch --url http://localhost:<web> --audio-only

# the film: 1080p60 in ~3 min on an M-series laptop; --scale 3 for 4K
bun apps/web/scripts/film/render.ts launch --url http://localhost:<web> --scale 1.5

# the contract between picture and score
bun test "apps/web/src/app/[locale]/presentations/film"
```

## Verification

A film is verified when all of these hold:

1. Contact sheet: one frame per beat, read at full size. Nothing clipped, no
   fallback font, no blank arrival.
2. `ffprobe` reports the expected size, fps, frame count, and an audio stream.
3. Cut frames land within ±1 frame of a bar line (`cues.json` against the grid).
4. Every string on screen traces to `kortix-brand` `positioning.md`, `concepts.md` or `claims.md`.

## Renderer notes — paid for once

- **One browser per worker.** A background tab throttles
  `requestAnimationFrame`, and `seek` waits on two frames: six tabs in one
  browser rendered at ~1 fps in total. Six browsers render at ~50 fps.
- **Raw CDP capture needs the scale in the clip.** `Page.captureScreenshot`
  ignores the emulated device scale; without `clip.scale` the "1080p" render is
  1280 × 720.
- **Chrome, not Chromium.** The product recordings are H.264, which open-source
  Chromium cannot decode. `render.ts` launches `channel: 'chrome'`.
- **A `'use client'` module cannot export data to a server component.** The
  film definition is imported by the route's `generateMetadata`; marked
  `'use client'` it arrives as a client reference with no `slug`, and the route
  404s. `films/<slug>/index.tsx` has no directive.
- **Autoplay respects reduced motion.** `FilmPlayer` derives `playing` from the
  reader's choice, else `autoPlay && !prefers-reduced-motion`.
