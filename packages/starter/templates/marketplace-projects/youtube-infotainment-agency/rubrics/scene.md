# Rubric — animated scene (`05-scenes/<id>.html`, judged on `qa/scenes/<id>-contact.jpg`, snapshots at each narrated line + check)

Judge what a viewer sees on one watch at normal speed. Anything found only by stepping through frames
or measuring pixels is a minor issue at most.

| criterion | 1 | 3 | 5 |
|---|---|---|---|
| `readability` | Cluttered, tiny text | Clear | Instantly readable at phone size; one focal point per moment; text inside safe area |
| `explanation` | Decorative | Illustrates the narration | The visual *carries* the explanation; a muted viewer would still get the idea |
| `sync` | Motion ignores voice | Roughly aligned | Key motions land on cue words (Kit.cue); nothing important appears after it's mentioned |
| `motion_quality` | Static after the reveal, linear or janky | Smooth, but mostly entrances | The idea plays out on screen for the whole scene: every narrated line moves something that carries meaning; purposeful easing, overlap and follow-through |
| `craft` | Strays from its style frame, misaligned | Clean, close to its frame | Recreates its style frame's look and finish (shape, colour, light, texture, type), consistent with the episode's other scenes |
| `accuracy` | Wrong diagram/data | Correct | Correct and honest (scale, units, labels); simplifications flagged |

Auto-fail: `yt scene check` not ok (lint/runtime/layout/contrast errors, duration mismatch); text
clipped or overlapping; a factual visual that contradicts claims.json.
