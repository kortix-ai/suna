# Rubric — final cut (`build/<slug>/final.mp4`, judged on `qa/final-contact.jpg`, `qa/final-seams.jpg`,
# `qa/final-qa.json` and the script; review file `qa/render-review.json`). Judge the assembled film: cuts, mix, pacing, captions. Each scene's internals
# already passed its own review; revisit one only when final QA flags it.

| criterion | 1 | 3 | 5 |
|---|---|---|---|
| `retention_design` | Viewer leaves at 0:30 | Holds attention | Hook, open loops and escalating reveals make it hard to stop watching |
| `audio` | Masked words, harsh music | Clean | Voice always clear; score supports the arc; SFX punctuate without clutter; −14 LUFS |
| `visual_flow` | Jumpy / repetitive | Coherent | Scenes flow with motivated transitions; variety of shot types; climax is the visual peak |
| `consistency` | Style drift between scenes | Consistent | One coherent film, not a slideshow of scenes |
| `accuracy` | Errors | Accurate | Accurate, with on-screen precision where narration simplifies |
| `polish` | Glitches, black frames | Clean | Broadcast-clean: no glitches, dead air, black frames, or typos |

Auto-fail: `yt qa final` not ok; any blocker from scene reviews still open; captions missing.
