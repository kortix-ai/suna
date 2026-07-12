---
name: personal-health
description: "Pull and analyze the user's own health data — wearable/device metrics (sleep, activity, steps, heart rate, HRV, recovery, workouts, body metrics, nutrition, menstrual cycle) and electronic health records (lab results, medications, conditions, allergies, immunizations, procedures). Use when someone asks 'how did I sleep this week', 'my steps this week', 'is my resting heart rate trending up', 'am I recovered enough to train', 'what were my last labs', 'what meds am I on', 'summarize my health', or anything that reads their personal wearable or clinical data. Handles wearable/device metrics directly and routes to the electronic-health-records sub-skill for clinical records. Marketplace skill — needs a configured Kortix health connector."
---

# Personal Health

> **Marketplace skill** — requires a Kortix health connector (wearables and/or EHR). Install it when one is configured; without a connected provider this skill has nothing to read. It handles **private health data** — read the Privacy Discipline section before you touch any of it.

This is the entry point for working with someone's own health data. It handles **wearable / device telemetry directly** (sleep, activity, heart rate, HRV, recovery, workouts, body metrics, nutrition, cycle — see "Wearable & Device Metrics" below), and hands off to a sub-skill for the clinical side:

- **Wearable & device metrics** (handled directly, in this skill) — anything a device or health app measures day to day: sleep, activity and steps, heart rate / HRV, recovery and readiness, workouts, body metrics, nutrition, menstrual cycle.
- **electronic-health-records** (sub-skill) — anything a clinic or lab holds: lab results and blood work, medications, diagnosed conditions, allergies, procedures, immunizations, appointments, patient summaries.

Many real questions span both ("are my resting-HR spikes lining up with my thyroid labs?"). When they do, query wearable metrics directly and the EHR connector through its sub-skill, then reconcile the two in your analysis.

## How the data actually reaches you

Kortix has no built-in health database. Every reading comes through a **connector** — a server-side broker that talks to a provider on the user's behalf and injects the result into your session. You never hold the user's provider password or token; the connector does, and Kortix only ever hands you the data.

Providers are examples, not hardcoded tools. Wearable data can come from Apple Health, Fitbit, Oura, Garmin, Whoop, Google Fit, or similar; clinical data from a FHIR-based health system or a lab platform. **Treat the connector generically** — discover what's actually connected, don't assume a specific brand is present.

### The connect → query → analyze loop

```
   ┌──────────┐     ┌──────────┐     ┌──────────┐     ┌──────────┐
   │ DISCOVER │ ──▶ │ CONNECT  │ ──▶ │  QUERY   │ ──▶ │ ANALYZE  │
   │ what's   │     │ if the   │     │ pull the │     │ trends,  │
   │ already  │     │ provider │     │ category │     │ context, │
   │ wired up │     │ is missing│    │ + range  │     │ caveats  │
   └──────────┘     └──────────┘     └──────────┘     └──────────┘
        │                                                   │
        └──────────────── never fabricate a reading ────────┘
```

1. **Discover.** List the connectors actually wired into this project before assuming anything is available — the `connectors` tool on the `kortix-executor` MCP, or `kortix executor connectors` from a shell. Unconnected providers are filtered out, so presence means it's usable. If a health connector for the requested data isn't there, go to step 2.

2. **Connect (only if missing).** Mint a setup link and surface the URL **in the same turn** — never send the user hunting through a settings dashboard, and never ask them to paste a token into chat. If the provider's connector isn't on the project yet, add it first (`add_connector` / `kortix executor add <slug> --provider pipedream --app <app>`), then mint the link (`connect` tool, or `kortix executor connect <slug>`). Then **end your turn** so they can authorize, and verify it landed (`kortix executor connectors`) before continuing. Full mechanics live in the `kortix-system` credentials-and-setup-links reference.

3. **Query.** Call the connector's read operation for the **data category** and **time range** the task needs (see each sub-skill for the category vocabulary and range limits). Pull only what the question requires — a sleep question doesn't need medication records.

4. **Analyze.** Turn raw readings into the answer: trends over time, comparisons to the person's own baseline, plain-language context. Keep numbers exactly as the provider reported them.

## Wearable & Device Metrics

Day-to-day body telemetry from whatever device or app the user wears — sleep, activity, workouts, vitals, recovery, body metrics, nutrition, cycle. Read it through a Kortix connector and turn it into an answer — a trend, a comparison to their own baseline, a recovery read — rather than dumping a table of raw samples.

The provider is generic. Apple Health, Fitbit, Oura, Garmin, Whoop, Google Fit — all are example sources reached the same way through Kortix's connector system. Discover what's actually connected; don't assume a brand.

### What you can pull

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

### Time range

Wearable questions are almost always about a window, so make the range explicit:

- **A single day** for "last night" or "today."
- **~7 days** is the sensible default for "this week" / "lately" / "what's my trend" when the user doesn't say.
- **A few weeks** for a trend that needs to settle (recovery patterns, HRV drift, cycle phases).

Providers cap how far back a single pull reaches and may thin older data to daily summaries. If the user wants a long history, fetch in windows and note any gaps rather than presenting a partial series as complete. Always state the window you actually pulled.

### How to run it

Follow the connect → query → analyze loop above. The wearables specifics:

1. **Confirm a wearables connector is live** (`connectors` tool / `kortix executor connectors`). If none is connected, mint a connect link for the provider the user names and surface it in the same turn — don't try to answer from nothing.
2. **Query** the connector's read operation with the **categories** and **time range** above.
3. **Analyze** against the person's own baseline. A resting HR of 60 means nothing in isolation; "8 bpm above your 30-day average, three nights running" means something.

### Example requests and how to read them

- *"How did I sleep this week?"* → sleep + recovery, last 7 days. Report average duration, deep/REM split, efficiency, and whether it's improving or sliding vs. the prior week.
- *"Is my resting heart rate creeping up?"* → vitals, ~3–4 weeks. Plot the daily resting-HR trend and call out any sustained rise (a possible signal of strain, illness, or poor sleep — phrased as context, not diagnosis).
- *"Break down my run on Tuesday."* → workouts, that day. Distance, pace, time in each HR zone, calories.
- *"Am I recovered enough to train hard today?"* → recovery + last night's sleep + overnight HRV. Summarize today's readiness against the recent norm; leave the call to them.
- *"Give me a two-week fitness snapshot."* → activity + sleep + vitals + workouts, 14 days. One scannable summary per category with the direction of travel.

Wearable metrics follow the same Privacy Discipline as the rest of this skill (below) — tag every figure with its provider, metric, and window (e.g. "Avg deep sleep 1h12m (Fitbit, last 7 nights)"), never invent a missing reading, and surface/contextualize rather than diagnose.

## Privacy Discipline

Non-negotiable. This is the most sensitive data the agent will ever touch.

- **It's private by default.** Health data stays inside the task the user asked for. Never copy it into shared docs, group channels, memory files, tickets, or any other surface unless they explicitly tell you to — and even then, surface only the specific figures needed.
- **Never fabricate a reading.** If a value is missing, gapped, or the connector returns nothing, say so. A made-up lab value or invented sleep score can drive a real health decision. No estimating, no back-filling, no "typical" stand-ins.
- **Mask and cite when sharing.** If output does leave the private context, reduce to what's necessary (a trend or range, not a full export), and attribute every figure to its source provider and date so it's auditable, not anonymous.
- **Cite source and recency on every number.** "Resting HR 58 bpm (Oura, avg of last 7 days)" — provider, metric, window. Stale data is a clinical hazard; always state the window.
- **Inform, don't diagnose.** Report and contextualize what the data shows. Don't deliver diagnoses, prescriptions, or dosage changes. For anything that reads as a medical decision, present the data and recommend a clinician.

## When there's no connector

Be upfront: this skill is dead without a configured health connector — there's no public dataset to fall back on the way a research skill has web search. If nothing relevant is connected, don't improvise. Explain which connector the request needs, offer to set it up via a connect link, and stop there.

## Sub-skills

| Need | Handled by |
| --- | --- |
| Sleep, activity, heart rate, HRV, recovery, workouts, body metrics, nutrition, cycle | **This skill** — see "Wearable & Device Metrics" above |
| Labs, medications, conditions, allergies, procedures, immunizations | **electronic-health-records** (sub-skill) |

The electronic-health-records sub-skill inherits the connect loop and the privacy rules above — don't re-derive them, apply them.
