---
name: art-direction
description: Turn a locked script + timing into a storyboard of scenes (storyboard.json) with visual concepts, archetypes, motion plans that act the idea out on the voice, SFX and style frames (drawn by the image model). Load for stage 4 visual concepting, or when re-planning scenes after a script change.
---

# Art direction (stage 4)

You decide what the viewer **sees**. The bar: a muted viewer should still follow the idea. Read
`channel/design.md` (palette meanings, archetypes, motion rules) and `channel/brand.md` first.

## Inputs
`03-script/script.json` (visual intents), `03-script/timing.json` (locked narration timing — scene
lengths come from it), `02-research/dossier.md` (visual leads), `bin/yt scene list <slug>` after a
first draft to see real durations.

## Plan scenes
- A scene covers **one or more consecutive beats** with one visual idea. Every beat is covered exactly
  once, in order (the CLI enforces this).
- Typical scene: 4–20 s. Over ~25 s, plan internal progression (camera moves, staged reveals) — the
  validator warns at 45 s. Under 2 s only for deliberate punches.
- Pick an archetype per scene (question card, mechanism diagram, scale journey, the number,
  comparison, timeline/map, analogy world, misconception shot) and vary them — wide/close,
  busy/quiet, dark/light — so the film has rhythm.
- Keep meanings consistent: the same concept looks the same in every scene (the misconception always
  looks one way). The model picks the colours, so check this on the style frame sheet.
- Recurring motifs: introduce a visual element early and pay it off later (the same molecule, the
  same ruler, Mote's reaction).
- `type`: `title`, `diagram`, `hf-2d` (illustrated scene), `hf-3d` (Three.js in HyperFrames — use
  sparingly), `genbroll` (atmosphere only, needs `broll_prompt`, off unless channel.yaml enables it;
  never for facts; total ≤20 % of runtime).
- `motion` — what happens on screen during every narrated line, not only what appears: the set-up,
  then the process acting the idea out until the scene ends ("the sun pops on 'sunlight'; on
  'scattered' rays leave it, hit molecules and bounce off in every direction, blue far more than red,
  and keep streaming to the cut"). If a line has nothing to act out, the visual idea is too static:
  rethink it. Ambient twinkle or drift is not a motion plan (`channel/design.md` → Motion principles).
- `on_screen_text` — exact strings; ≤7 words each; precise figures belong here.
- `sfx` — at most one per meaningful event: `{prompt, beat, at_word, duration, volume}`.
- `transition_in` — cut (default), wipe (new chapter), zoom (scale), match (shared shape), fade.

## Style frames (the image model draws them)
Every scene except `genbroll` gets a style frame: its key frame, the picture the scene builds up to,
drawn by the image model as the ideal version of the video. The frames set the episode's look, and the
animator recreates each one in code. Don't build style frames in HyperFrames.
- `styleframe_prompt`, per scene: 2–4 sentences on **what** that frame shows, not how it is styled: the
  objects, where they sit and how big, what they are doing at the key moment, and what the frame must
  make clear ("the black film is visibly darker than its surroundings, with a lit rim"; "the two waves
  are exactly out of step, crest over trough"). Leave the look to the model: no colours or colour names,
  palette, line art, flat-vector, cards, chips, shading, grain or fonts, unless the science needs a colour
  (a star's colour, Jupiter's real bands).
- The model draws everything the prompt names, so name Mote only in frames Mote is in, and there
  describe Mote as "the channel mascot, a small round yellow character with big eyes". The only words
  it may draw are the scene's `on_screen_text`; the art direction comes from
  `channel.yaml → styleframes.look`.
- Draw them all at once: `bin/yt storyboard frames <slug>`. Six frames took 72 s in a test, at about
  $0.17 a frame on `gpt-image-2` (recorded in `bin/yt cost`). It links each frame in `styleframe` and makes
  `qa/styleframes.jpg`.
- Look at the sheet: does each frame carry its scene's idea at a glance, do they look like one video, and
  does each concept look the same in every frame it's in?
  When a frame misses the idea, sharpen that scene's prompt and run
  `bin/yt storyboard frames <slug> --scenes <scene>` for a new one (also for a frame whose look clashes
  with the rest). Don't redraw for details: test frames (23 Oct 2026) had waves in step, underlines for
  strike-throughs, and an extra title and mascots. The animator checks the frame against your storyboard
  and builds the corrected scene.
- Open a single frame only for a detail the sheet is too small to show: every image you open stays in
  your context and slows each later step. Style frames are references, never footage in the video.

## Output & checks
`04-visual/storyboard.json` (schema `Storyboard`: `style_notes`, `scenes[]`), then:
```bash
bin/yt validate <slug> storyboard     # coverage, durations, b-roll caps
bin/yt broll budget <slug>
```
The storyboard gate shows the human your table and style frames — make `concept` lines vivid.
