# Packaging learnings (titles, thumbnails, descriptions)

Lessons from packaging a first episode (a 78 s explainer on why we don't feel Earth's spin). The checks
below run offline with PIL + tesseract; build them as small scripts in the episode's `qa/` folder.

## Thumbnail legibility is measurable — do that instead of squinting

- The binding constraint is the **~120 px mobile feed**, not 1280×720. At 120 px wide (scale 0.09375) a
  display-font size of S px has cap height ≈ 0.72·S·0.09375; a packaging review wanted
  **cap ≥ 9 px and stroke ≥ 3 px at 120 px for every text run**, which is what the final card has
  (`FEELS LIKE` 140 px → 9 px cap / 5 px stroke; `0` 250 px → 17 px / 4 px; `km/h` 190 px → 13 px / 3 px).
  A 120 px label measured 8 px cap / 1.5 px stroke and was flagged as the weakest element even though it
  OCR'd — treat 8 px cap / thin strokes as the floor, not the target.
- **OCR the downscaled PNG** (tesseract, `--psm 6`) as the acceptance test, both the whole image and a
  padded crop per text run — a whole-image pass at 120 px is the critic's own method, and per-run crops
  are what isolate a weak element. Pair it with cap height, stroke width and ink-vs-background modulation
  (≥170 levels).
- The kit **vignette dims corner text ~20%** (paper 246,241,231 → 196,192,187 in the top-left corner):
  report a *worst case* contrast (p10 ink vs p90 bg), not the median. That card still measured
  12.0:1 worst-case, so the WCAG 3:1 large-text floor is not the risk — **ink on the kit globe is**:
  sun `#ffc94a` on the globe disc `#2b7fd4` is ~2.7:1. Keep type off the planet or put it on `--ink`.
  Before growing a text run, measure the headroom: on this card the label's ink ends 297 px left of the
  nearest planet pixel, so the type could grow without touching the hero.
- Measure the safe area in the thumbnail's own coordinates: 1280×720 ≈ 80 px sides / 60 px top-bottom
  (the 1920×1080 rule scaled). Text ink 6–8 px inside the CSS `left` is normal (side bearing).

## Titles

- The strongest hook for this episode was **the film's own first sentence, compressed** — front-load the
  number, then the paradox ("You're Moving at 1,674 km/h. Why Can't You Feel It?"). It scored 9 against
  the exact-query title ("Why Don't We Feel the Earth Spinning?", 7) which an existing video already owns
  verbatim. Winning titles do not need the query string.
- **Title and thumbnail should split the two halves of the paradox**, not repeat it: the title carried the
  measured speed, the thumbnail the inversion (`FEELS LIKE 0 km/h`, the film's own sc07 readout). The
  packaging rubric's "complements, not repeats" is enforceable — check for shared tokens.
- A number in the title is only honest with its condition. `1,674 km/h` is the *equatorial* speed
  (c01 says the speed is lower at higher latitudes). The first package was **blocked** on
  "You're Moving at 1,674 km/h" — ~40% high at 51°N — even though the film says the same thing with
  "if you're near the equator" and labels the on-screen readout "at the equator". The film qualifying a
  figure on screen does **not** license the title to drop the qualifier: the title is the most-read
  sentence the channel publishes. "up to 1,674 km/h" (the equatorial maximum) is strictly true
  everywhere and costs nothing; the package audit should assert it explicitly.
- Put the subject noun in the title **or** the description's first three paragraphs. A package can be
  perfectly accurate and never say what the video is about — the review scored that as
  discoverability (4/5) and noted that tags carry almost no ranking weight.
- Keep each rationale's character count honest: recompute it and assert it (a package audit asserts
  `"N chars." == len(text)` for every title). A human checks the 60-char limit against that number.

## Description & disclosure

- Audit the copy mechanically: extract every numeric token from title/description/thumbnail text and
  match it to a verified claim id (a package audit script does this, plus banned words and chapter rules).
  It caught a real over-claim in this episode: writing "…cancels 0.3% of gravity's pull, **which is why
  you weigh a little less at the poles**" quietly attributes the whole 0.53% pole/equator gravity gap to
  the spin, when the film's own caption says "spin + Earth's shape". Cut the clause or spell out both
  causes — never let a description be looser than the film.
- Same rule for a stylised sequence: if the scene flags `time-lapse` on screen, the description must not
  imply real-time motion (and need not repeat the flag).
- `contains_synthetic_media: false` held for a fully code-drawn card; disclose the synthetic *narration*
  and the generated score in the description credit line instead, since the YouTube flag only covers
  realistic synthetic depictions.
- Chapters can only come from the script's `chapter` fields (`yt sources` reads `03-script/script.json`,
  which the package stage may not edit). A chapter the script didn't mark can't be added at
  packaging: the script file has to change first, and `yt episode reopen … script` invalidates the voice
  and render — don't reopen a finished cut for a label.
- **Chapter labels must never land before the beat they name.** `mmss()` in `pipeline/src/sources.ts`
  floors, so a beat at 34.97 s printed `00:34`, ~1 s early into the previous scene; the pipeline now
  rounds chapter labels up (`mmssChapter` in `description()`), while the sources page's claim timestamps
  keep the floored form. The ≥10 s rule is still evaluated on raw times.
