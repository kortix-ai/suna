---
name: wearables-data
description: "Read and analyze data from a connected wearable or health app — sleep stages and duration, activity and steps, workouts, heart rate and HRV, recovery/readiness, body metrics, calories and nutrition, and menstrual cycle — over a chosen time range. Use when the user asks 'how did I sleep last night', 'my steps this week', 'is my resting heart rate trending up', 'how was my last run', 'am I recovered enough to train', or wants a fitness/sleep summary. Marketplace skill — requires a connected wearables provider (e.g. Apple Health, Fitbit, Oura, Garmin, Whoop)."
---

# Wearables Data

> **Marketplace skill** — requires a Kortix health connector for a wearable / health app. Install it when one is configured; with nothing connected there's no device data to read. It handles **private health data** — see the Privacy section and the parent `personal-health` skill before you touch any of it.

Day-to-day body telemetry from whatever device or app the user wears. This sub-skill reads it through a Kortix connector and turns it into an answer — a trend, a comparison to their own baseline, a recovery read — rather than dumping a table of raw samples.

The provider is generic. Apple Health, Fitbit, Oura, Garmin, Whoop, Google Fit — all are example sources reached the same way through Kortix's connector system. Discover what's actually connected; don't assume a brand.

## What you can pull

| Category | Typical metrics |
| --- | --- |
| **Sleep** | Total sleep, time in bed, stages (deep / REM / light), latency, efficiency, a nightly score |
| **Activity** | Steps, active and total calories, distance, active minutes, sedentary time, floors |
| **Workouts** | Per-session type, duration, distance, pace, calories, heart-rate zones |
| **Vitals** | Resting and continuous heart rate, HRV, respiratory rate, SpO₂, skin/body temperature |
| **Recovery** | Readiness / recovery / strain scores where the provider computes them |
| **Body** | Weight, body-fat %, lean mass, BMI (when the device or a paired scale reports it) |
| **Nutrition** | Logged calories in, macros, water intake, caffeine — only if the user logs them |
| **Cycle** | Menstrual cycle phase, period and fertile windows, cycle-linked temperature and HRV shifts |

Pull only the categories the question needs. "How did I sleep?" wants sleep (and maybe recovery and overnight HR) — not steps, not workouts.

## Time range

Wearable questions are almost always about a window, so make the range explicit:

- **A single day** for "last night" or "today."
- **~7 days** is the sensible default for "this week" / "lately" / "what's my trend" when the user doesn't say.
- **A few weeks** for a trend that needs to settle (recovery patterns, HRV drift, cycle phases).

Providers cap how far back a single pull reaches and may thin older data to daily summaries. If the user wants a long history, fetch in windows and note any gaps rather than presenting a partial series as complete. Always state the window you actually pulled.

## How to run it

The connect → query → analyze loop lives in the parent `personal-health` skill — follow it. The wearables specifics:

1. **Confirm a wearables connector is live** (`connectors` tool / `kortix executor connectors`). If none is connected, mint a connect link for the provider the user names and surface it in the same turn — don't try to answer from nothing.
2. **Query** the connector's read operation with the **categories** and **time range** above.
3. **Analyze** against the person's own baseline. A resting HR of 60 means nothing in isolation; "8 bpm above your 30-day average, three nights running" means something.

### Example requests and how to read them

- *"How did I sleep this week?"* → sleep + recovery, last 7 days. Report average duration, deep/REM split, efficiency, and whether it's improving or sliding vs. the prior week.
- *"Is my resting heart rate creeping up?"* → vitals, ~3–4 weeks. Plot the daily resting-HR trend and call out any sustained rise (a possible signal of strain, illness, or poor sleep — phrased as context, not diagnosis).
- *"Break down my run on Tuesday."* → workouts, that day. Distance, pace, time in each HR zone, calories.
- *"Am I recovered enough to train hard today?"* → recovery + last night's sleep + overnight HRV. Summarize today's readiness against the recent norm; leave the call to them.
- *"Give me a two-week fitness snapshot."* → activity + sleep + vitals + workouts, 14 days. One scannable summary per category with the direction of travel.

## Privacy

Same discipline as the parent skill — applied here:

- This is private telemetry. Keep it in the task; don't echo someone's sleep scores or weight into shared docs, channels, or memory unless they explicitly ask.
- **Never invent a number.** A missing night or a sync gap gets reported as missing — not estimated, not smoothed over. A fabricated recovery score can send someone into a workout they shouldn't do.
- Tag every figure with its provider, metric, and window: "Avg deep sleep 1h12m (Fitbit, last 7 nights)."
- Surface and contextualize; don't diagnose. An elevated resting HR is an observation to flag, not a condition to name.

## Related

- **personal-health** — parent dispatcher: the connect loop, connector discovery, and the full privacy rules.
- **electronic-health-records** — the clinical side (labs, meds, conditions); pair the two when a wearable trend needs lab context.
