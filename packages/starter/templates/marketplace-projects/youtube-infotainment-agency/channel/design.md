# Channel bible — visual design

Each episode's look comes from its **style frames**: the image model draws every scene's key frame as
the ideal version of the video (`channel.yaml → styleframes.look`), and the animators recreate that look
in code (HyperFrames). What stays the same in every episode is how the channel explains: colour that
means something, readable text, honest scale and motion that acts the idea out. The kit (`kit/`) gives
voice-cue timing (`Kit.cue`), motion helpers and a default palette and type for anything a frame
doesn't decide. The animator and critic both read this page.

## Colour (carries meaning)
The frames choose the palette. Within an episode the same concept keeps the same colour and shape in
every scene, and the misconception always looks the same; never encode meaning in colour alone (label
it too). Text must pass WCAG 3:1 for large text (`yt scene check` enforces contrast).

The kit's default palette (`kit/kit.css`), for anything a frame doesn't decide:

| token | hex | meaning |
|---|---|---|
| `--ink` | #0e1b3d | night / space / the unknown — default background |
| `--deep` / `--dusk` | #162a5c / #24407f | panels, far layers, depth |
| `--sky` (`--sky-deep` on light bg) | #3fa7f5 / #1554b8 | the main subject, "science blue", light |
| `--mint` | #3fe0b0 | life, growth, correct answers |
| `--sun` | #ffc94a | energy, heat sources, Mote, the payoff number |
| `--coral` | #ff6b5e | danger, heat, **the misconception** |
| `--violet` | #8e6cf0 | the invisible: fields, quantum, probabilities |
| `--paper` / `--muted` | #f6f1e7 / #9fb0d6 | text and line art / secondary text |

## Typography
- Typefaces come from the frame: use the closest one installed locally (Fredoka and Inter in
  `pipeline/node_modules/@fontsource-variable`, or a system font). No web fonts: scenes load nothing
  from the network. Kit default: **Fredoka** for titles, labels and numbers, **Inter** for small text.
- Kit scale: title 104, h2 72, label 38, small 28, stat 180 px (classes in kit.css).
- ≤ 7 words of on-screen text per idea; on screen at least `0.35 s × words + 0.6 s`.
- Text lives inside the safe area: 120 px sides, 90 px top/bottom.

## Illustration
- Recreate the style frame's look as closely as HyperFrames allows: inline SVG with gradients and
  filters, CSS, canvas, WebGL/Three.js, anything deterministic. Composition, shape, colour, light,
  depth, texture and type all come from the frame.
- Everything is built in code: never put the frame image, a crop of it or a trace of it into a scene.
- Scale honesty: when sizes or quantities are compared, draw them to scale or say "not to scale".

## Motion principles
1. **A scene acts out its idea for its whole length.** Bringing elements in is only the set-up. Once
   they are there, what the narration describes happens on screen: light travels and bends, the image
   dances, the count runs, the waves slide in and out of step, the camera follows the process. Every
   narrated line changes something that carries meaning. A scene that reveals its picture and then
   holds it is a slide, not animation.
2. **Motion is on the voice.** Entrances and each step of the process hit their narration words via
   `Kit.cue(CUES, beat, word)`. Motion explains; nothing moves only to decorate.
3. One idea per moment. Bring elements in, act the idea out, then clear the stage for the next one.
4. Easing vocabulary: entrances `power3.out` / `back.out(1.8)` for pops; exits `power2.in`; camera
   `power2.inOut`; continuous drift `none` or `sine.inOut`. No linear entrances.
5. Ambient life is texture, not animation: twinkling stars, a floating Mote or drifting clouds can sit
   under the action, but a few pixels of drift or breathing never count as the scene's motion, and they
   must not compete with the subject. A short still beat while the viewer reads is fine.
6. Camera moves (`Kit.camera`) signal changes of scale or focus — zoom in to go small, out to go big.
7. Transitions: `cut` by default; `wipe` for a new chapter; `zoom` for scale journeys; `match` when two
   scenes share a shape. Never use a transition just to fill time.

## Scene archetypes (pick, then make it specific)
- **Question card** — the cold-open question over an evocative world shot.
- **Mechanism diagram** — the process drawn on step by step, labels on cue.
- **Scale journey** — camera zoom through orders of magnitude with a ruler/units.
- **The number** — one big stat counting up, with a tangible comparison.
- **Comparison** — two things side by side, same scale, one variable changed.
- **Timeline / map** — history or geography, revealed left-to-right / place-by-place.
- **Analogy world** — the abstract idea re-cast as a toy world (marbles, roads, crowds), then mapped
  back explicitly to the real thing.
- **Misconception shot** — the wrong model drawn in the episode's misconception colour, then visibly
  corrected.

## Don't
- No walls of text, bullet lists or slides. If it reads like PowerPoint, redraw it.
- No clip-art icons with no relationship to the narration.
- No generative b-roll for anything factual (diagrams, data, maps, real people, real events).
- No identical scene templates across episodes; reuse components, not compositions.
