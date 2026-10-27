# Production notes

Reusable lessons from building the pipeline and producing a first episode end to end. Each entry is a
trap that cost real debugging time; numbers are measurements from that production.

## Render and composition (HyperFrames)
- **Render speed**: 10 s of 1080p30 ≈ 26 s on 4 vCPU (software GPU). Measure on your sandbox size
  before budgeting; scene renders are cached by content hash.
- **Static lint** wants a literal `window.__timelines["<id>"] = tl` in each composition even though
  `Kit.scene` registers it too — keep both.
- **Nested timed elements** (`class="clip"` wrappers with children) trigger a Studio-oriented warning;
  use an untimed `#world` wrapper inside the timed root instead.
- **Contrast check** is strict and useful: sky-blue text on light backgrounds fails; use `--sky-deep`.
- **Fonts**: only mapped or @font-face fonts are deterministic; the kit ships Fredoka + Inter. Their latin
  subsets have no `≈` (U+2248) — write approximations as `~0.3%`. Check a glyph before it goes on screen:
  `uv run --with fonttools --with brotli python3 -c "from fontTools.ttLib import TTFont; print(ord(ch) in TTFont(path).getBestCmap())"`.
- **Frame drift**: HyperFrames rounds each scene up by ~1 frame, so 7 scenes drifted ~2 frames behind the
  voice. Fixed in the pipeline: scene windows snap to the frame grid and the concat re-encodes with
  per-scene `outpoint`. Final = exactly timing × fps.
- **Frame 0 of every scene must already be a picture**: carry the motif element in at rest and fade only
  text up on its word. Cheap detector: `(abs(lum - median) > 25 | sat > 60).mean()` per snapshot —
  0.00 means empty.
- **Lint's line budget is on the BUILT composition and counts structural lines** (`MAX_COMPOSITION_LINES
  = 300`; the `<style>` block's inner lines are free). Verbose comments can trip
  `composition_file_too_large`. When trimming comments, re-run the check: an edit that drops a trailing
  newline can join the next statement into a `//` line (runtime `X is not defined` while static lint
  still reads 0 errors).

## SVG + GSAP traps
- **Tweening `x/y/scale/rotation` on an SVG element positioned with a `transform` attribute replaces the
  attribute** (CSS transform wins) and snaps it to the origin. Wrap it:
  `<g transform="translate(...)"><g id="animatable">…</g></g>` and tween the inner group. `tl.set` on a
  parent's opacity then animating children leaves the parent invisible.
- **Don't trust `svgOrigin`/`transformOrigin` for scale or rotation on SVG groups**: GSAP's internal values
  can read correct while the emitted matrix is 50 px off. Pure translates are safe; anything with scale or
  rotation, write the attribute yourself in `onUpdate`
  (`el.setAttribute("transform", \`translate(${x} ${y}) scale(${s})\`)`) and verify with `getCTM()`.
- **A disc turning in perspective: rotate in plane, then squash** —
  `<g transform="translate(cx,cy) scale(1, ry/R)"><g id="spin">…</g></g>`, animate `#spin` with pure
  rotation. A rigid screen-space rotation of an ellipse is geometrically wrong (points drift off the rim).
- **An SVG `clipPath` is evaluated in the local space of the element that carries it**: on an animated
  `<g>` the clip drifts with it. Put the clip on an untransformed parent, or mask in HTML
  (`border-radius: 50%; overflow: hidden`), which clips exactly at any camera scale.
- **`Kit.drawOn` + an existing `stroke-dasharray`** merges into `len, 24px` and shows the line from t=0.
  Build dashed lines as real segments and draw them on with a stagger. **Round linecaps** leave a visible
  blob at the path start before the reveal and inflate dashes (a 24 px dash becomes a 36 px pill): use
  butt caps on drawOn targets and dashed motifs.
- **A tween that names no ease inherits `Kit.scene`'s `power3.out`**: a "steady spin" silently
  decelerates. Use `ease: "none"` for constant rates.
- **`.k-line` CSS overrides stroke presentation attributes**: `stroke="var(--coral)"` on a `.k-line`
  renders paper-white. Set colour via style/class, and check it on a snapshot.
- **GSAP stagger + yoyo + repeat re-applies the stagger every cycle**: total =
  `[dur + stagger*(n-1)] * (repeat+1)`. Compute the end from that; don't assume per-target offsets.
- **`Kit.float(..., from, to)` under-covers by design** (`reps = floor((to-from)/(period/2)) - 1`): the bob
  ends before `to` and can leave a frozen tail. Re-aim `to` or add an explicit yoyo tween.
- **`tl.seek(t)` suppresses events by default**: onUpdate-driven proxies look stale under a plain seek.
  A script that seeks the timeline must call `tl.seek(t, false)` (the renderer fires events, so renders
  are correct).

## Scene QA the checks can't see
- **"Animated but never shown"**: an element that starts at `opacity="0"` and is only rotated passes
  lint, layout, motion and contrast. Grep each scene for initial `opacity 0`, make sure every id has a
  tween that raises it, and look at a snapshot after its cue.
- **Sibling/text overlap is invisible to `yt scene check`** (it tests overflow only). Look at the
  snapshots where text sits near other text; a 0×0 absolutely positioned container makes its pills
  shrink, wrap and overlap, so give it a real width.
- **A committed styleframe is the DESIGN state, not a timeline frame**: reproduce its geometry at rest
  and time the entrances around it. When a still pins positions or layer order, compare a snapshot at
  that moment with it.
- **Derive a pinned position from the formula, check the absolute value**: a self-consistent harness
  verifies your convention, not the plan's numbers.
- **A camera "wide view" needs a world bigger than the frame**: draw the room at the widest view's size
  (1920/scale × 1080/scale) so the frame is all world at the widest point.
- **Look at frames first**: the default models read images, so judge snapshots and contact sheets by
  eye. Only when the image tool can't open a PNG, verify a still without eyes: build it as a
  composition, `hyperframes snapshot --at <t> --no-end`, `hyperframes check` for contrast, OCR the
  labels, and print a quantised luminance map to see composition and collisions.

## Timing and re-voices
- **Timing is narration-first**: voice before storyboard; scene durations derive from beats; `yt scene
  retime` re-syncs cue blocks after any re-voice because scenes reference cue words, not seconds.
- **`Kit.cue` takes the FIRST occurrence of a word**: pass `nth` through the scaffold's `C()` helper
  whenever a word repeats in the beat ("you", "the", "a").
- **After a re-voice, hunt literals**: hard-coded timestamps, and any *duration* computed from a word pair
  (turn lengths, dwell bounds), go stale and silently un-coordinate paired elements. Derive them from the
  cues in code.
- **Timing-only storyboard re-time**: when words are unchanged, re-time by intent (quoted scene-relative
  seconds move with their words), keep design untouched, and say "timing-only update" in `style_notes`.
- **Gates don't reopen by themselves**: after a reopen, `yt gate request <slug> <gate> --submit` creates
  a new review; without `--submit` it writes the packet and sends nothing. State in the packet which
  review it supersedes, and rewrite `qa/gate-<gate>-notes.md` (it is embedded verbatim).
- **Check a review file is fresh before trusting it**: a subagent can return an empty result and write
  nothing, leaving an older review that looks current. Compare mtime and duration with the delivered cut.

## Narration (ElevenLabs)
- **Write pauses into the text** (`channel/audio.md → Pauses`) and re-measure with `yt voice report` after
  every change: the marks are directions, not guarantees — one ellipsis can still come back at 0.08 s.
  List-internal comma gaps of 0.08–0.24 s are natural prosody; don't reword for them.
- **"Still robotic?" is checkable without ears**: per-beat autocorrelation F0 (40 ms frames, 80–400 Hz).
  A flat synthetic read shows an IQR of a few Hz; a natural read moves tens of Hz across beats.
- **A take can end mid-voicing** (an audible tick into the pause). Check the last 5 ms RMS
  (> −25 dBFS is suspicious). It is take-dependent: delete `media/narration/<beat>.*` and re-run
  `yt voice` to re-roll. `speech_end == file duration` says nothing about truncation.
- **ASR for audits**: `hyperframes transcribe` needs a model in the sandbox
  (`hyperframes models install parakeet`, ~640 MB); pass `-d /tmp/…` to keep transcripts out of the repo.
  Fold number/spelling formats ("1700", "kilometers") before comparing with the script.
- **Agents that pin a model whose provider isn't connected fail dispatch** (`provider_not_connected`).
  Leave `model:` out of `agents/*.md` so they follow the project default.
- **Free local voice for drafts**: `yt voice --provider kokoro`, aligned via `hyperframes transcribe`.

## Music, SFX and the mix
- **Generated takes vary widely in level** (one SFX prompt returned takes from −42 to −12 dBFS peak; music
  cues arrive −18…−22 LUFS). `mixMaster` normalises music to `music.reference_lufs` and SFX to
  `sfx.reference_peak_db` before the planned volume; the gains land in `qa/render.json`.
- **SFX prompt wording sets the level**: "quiet/soft/gentle" briefs come back quiet; prefer "short, crisp,
  wooden".
- **Music prompt arcs work when they describe growth, not absence** ("wonder growing out of stillness …
  swelling to the fullest climax"). Measure every cue's 1 s RMS envelope against its act before accepting.
- **A generated cue resolves 5–6 s before its requested end**, so adjacent cues are crossfaded
  (`mix.music_crossfade_s`, equal-power `qsin`). A seam whose outgoing cue resolves early can't be fixed
  by the crossfade alone; it depends on the incoming cue's opening level. Sustain-tail prompt suffixes
  did not move the decay.
- **Regenerating a cue at a new length re-rolls everything** (holes, swells, peaks), not just the ending.
  Re-measure every descriptor. Save good takes before deleting files to re-roll — a lost take can't be
  regenerated (the cache key is prompt + length, so re-installing saved files is free).
- **Tune score-vs-voice on speech-active frames** (voice active at > max − 30 dB, 50 ms frames), never on
  whole-beat averages. This channel's reference: score 12–16 dB under the voice during speech, ~8 dB duck,
  punctuation SFX 6–11 dB under the local voice peak. A voice change shifts duck gain-reduction readings;
  the placement is the invariant.
- **`sidechaincompress` ends with its shorter input**: an unpadded narration key mutes everything after
  the last word. The pipeline pads the narration *bus*. Padding the key *branch* instead livelocks ffmpeg
  (file written, then 100 % CPU forever) — always check a filtergraph exits, not just that the file appears.
- **ffmpeg uses a filtergraph output label once**: add an `asplit` copy for any label you both consume and
  `-map`.
- **Derive stage inputs from state files** (`timing.json`, `sound.json`), not from numbers quoted in a
  dispatch.
- **"Sparse" music prompts buy silence, not space**: cues prompted "sparse / long silences / decays into
  silence" came back with 3–12 s of real audio in 16–20 s takes, so the bed vanished mid-act. "Plays
  continuously from the first bar to the last, no silent gaps, no fade-out and no ending" fixed most of
  them; the provider still tends to resolve 4–5 s early. Take normalisation is peak-capped (−3 dBTP), so a
  peaky take needs a higher cue volume. Measure every take's LUFS, true peak and windowed levels.
- **Short SFX draws are often near-silent**: 5 of 6 draws of a 0.5 s "single wooden ruler tick" came back
  at −48…−54 dBFS peak, beyond what normalisation can lift. Save each take, pick by measured peak, and
  install the winner at its cache path instead of re-rolling blind.
