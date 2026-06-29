---
name: personal-health
description: "Pull and analyze the user's own health data — wearable metrics (sleep, activity, steps, heart rate, HRV, recovery, workouts, nutrition, cycle) and electronic health records (lab results, medications, conditions, allergies, immunizations, procedures). Use when someone asks 'how did I sleep this week', 'what were my last labs', 'what meds am I on', 'show my resting heart rate trend', 'summarize my health', or anything that reads their personal wearable or clinical data. Routes to the wearables-data and electronic-health-records sub-skills. Marketplace skill — needs a configured Kortix health connector."
---

# Personal Health

> **Marketplace skill** — requires a Kortix health connector (wearables and/or EHR). Install it when one is configured; without a connected provider this skill has nothing to read. It handles **private health data** — read the Privacy Discipline section before you touch any of it.

This is the entry point for working with someone's own health data. It doesn't fetch anything itself — it figures out *which* kind of data the request needs, confirms a connector can serve it, and hands off to the right sub-skill:

- **wearables-data** — anything a device or health app measures day to day: sleep, activity and steps, heart rate / HRV, recovery and readiness, workouts, body metrics, nutrition, menstrual cycle.
- **electronic-health-records** — anything a clinic or lab holds: lab results and blood work, medications, diagnosed conditions, allergies, procedures, immunizations, appointments, patient summaries.

Many real questions span both ("are my resting-HR spikes lining up with my thyroid labs?"). When they do, query each connector through its sub-skill and reconcile the two in your analysis.

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

| Need | Sub-skill |
| --- | --- |
| Sleep, activity, heart rate, HRV, recovery, workouts, nutrition, cycle | **wearables-data** |
| Labs, medications, conditions, allergies, procedures, immunizations | **electronic-health-records** |

Each sub-skill inherits the connect loop and the privacy rules above — don't re-derive them, apply them.
