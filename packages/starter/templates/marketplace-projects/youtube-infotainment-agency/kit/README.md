# kit/ — the house HyperFrames toolkit

Every scene and thumbnail links `kit/kit.css`, `kit/vendor/gsap.min.js` and `kit/kit.js`.
`bin/yt scene build` copies this folder next to the scene (plus vendored GSAP and the Fredoka/Inter
fonts from `pipeline/node_modules`) so renders are offline and deterministic.

| file | what |
|---|---|
| `kit.css` | palette tokens, type scale, backgrounds, components (`k-card`, `k-chip`, `k-callout`, `k-lower-third`, `k-line`), grain/vignette, Mote styles |
| `kit.js` | `Kit.scene`, `Kit.cue`, `Kit.beatEnd`, `Kit.pop`, `Kit.fadeUp`, `Kit.fadeOut`, `Kit.drawOn`, `Kit.typeOn`, `Kit.countUp`, `Kit.float`, `Kit.blink`, `Kit.camera`, `Kit.wipe`, `Kit.stars`, `Kit.mascot`, `Kit.mount`, `Kit.rng` |
| `templates/scene.html` | what `yt scene scaffold` starts from |
| `templates/thumbnail.html` | what `yt thumb scaffold` starts from (1280×720) |

Worked examples: `pipeline/test/fixtures/episode/05-scenes/sc01–sc03.html`.

Changing the look of the channel = editing `channel/design.md` first, then these tokens. Keep helpers
deterministic (no `Math.random`, no `Date`, finite repeats) — HyperFrames seeks frames out of order.
