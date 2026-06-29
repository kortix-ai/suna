---
name: electronic-health-records
description: "Read and analyze a connected electronic health record — lab results and blood work, current and past medications, diagnosed conditions, allergies, procedures and surgeries, immunizations, appointments, and patient summaries. Use when the user asks 'what were my latest labs', 'what medications am I on', 'what's my medical history', 'am I up to date on vaccines', 'what am I allergic to', or wants a clinical summary. Marketplace skill — requires a connected EHR / medical-records provider (e.g. a FHIR-based health system or lab platform)."
---

# Electronic Health Records

> **Marketplace skill** — requires a Kortix health connector for an EHR or medical-records provider. Install it when one is configured; with nothing connected there are no records to read. It handles **private clinical data** — the most sensitive data the agent will ever touch. Read the Privacy section and the parent `personal-health` skill before you touch any of it.

Clinical records held by a clinic, hospital, or lab — read through a Kortix connector and turned into a clear answer. Where the wearables sub-skill deals in daily telemetry, this one deals in the formal medical record: what a provider has diagnosed, prescribed, measured, or administered.

The provider is generic. A FHIR-based health system, a patient-portal aggregator, or a lab platform are all example sources reached the same way through Kortix's connector system. Discover what's actually connected; don't assume a brand.

## What you can pull

| Category | What it holds |
| --- | --- |
| **Labs & blood work** | Test panels with values, units, and reference ranges; results over time |
| **Vitals** | Clinically recorded blood pressure, heart rate, weight, BMI, temperature |
| **Medications** | Active and historical prescriptions — drug, dose, frequency, prescriber, dates |
| **Conditions** | Diagnoses and problem list, active and resolved |
| **Allergies** | Substances, reactions, severity |
| **Procedures** | Surgeries, interventions, imaging, with dates |
| **Immunizations** | Vaccines administered and dates |
| **Appointments** | Past and upcoming encounters |
| **Patient summary** | A consolidated snapshot pulling the above together |

Pull only what the question needs. "What am I allergic to?" wants the allergy list — not the full record.

## How to run it

The connect → query → analyze loop lives in the parent `personal-health` skill — follow it. The EHR specifics:

1. **Confirm a medical-records connector is live** (`connectors` tool / `kortix executor connectors`). If none is connected, mint a connect link for the provider the user names and surface it in the same turn. Don't answer clinical questions from nothing.
2. **Query** the connector's read operation for the **categories** you need. Records are usually point-in-time, not windowed — but for labs and vitals, a date range turns a single value into a trend.
3. **Analyze** faithfully. Carry values, units, and reference ranges through exactly. When a lab sits outside its range, note it as out-of-range — flagged for the user, not interpreted into a diagnosis.

### Example requests and how to read them

- *"What were my latest labs?"* → labs, most recent panel. List each value with its unit and reference range, and mark anything out of range. Don't editorialize beyond "above/below range."
- *"Has my cholesterol moved over the last few years?"* → labs, lipid panel, full available history. Show the trend per marker (LDL, HDL, triglycerides) with dates.
- *"What medications am I currently taking?"* → medications, active only. Drug, dose, frequency, prescriber, start date.
- *"Am I up to date on my vaccines?"* → immunizations. List what's recorded with dates; flag gaps as "no record found," not "you haven't had it."
- *"Give me a one-page summary before my appointment."* → patient summary (or assemble from conditions + active meds + recent labs + allergies). One clean, sourced page they can hand to a clinician.

## Privacy

The strictest tier of the parent skill's discipline applies here:

- **Maximum confidentiality.** Diagnoses, medications, and lab values never leave the task. Never write them into shared docs, channels, memory, or any persistent surface unless the user explicitly directs it — and then only the specific items needed.
- **Never fabricate a clinical value.** If a lab, med, or record is absent, report it as not found. An invented test result, dose, or diagnosis is a direct safety risk. No estimating, no inferring a value from context.
- **Mask and cite when sharing.** If anything leaves the private context, reduce to the minimum (a single flagged marker, not the whole panel) and attribute every value to its source and date.
- **Carry units and ranges, always.** "LDL 142 mg/dL (ref < 100; LabName, 2026-05-12)." A bare number is unusable and dangerous.
- **Report, don't practice medicine.** Surface what the record says and flag out-of-range or notable items. Do not diagnose, do not adjust medications, do not tell anyone to start or stop a drug. For any decision, present the data and point to their clinician.

## Related

- **personal-health** — parent dispatcher: the connect loop, connector discovery, and the full privacy rules.
- **wearables-data** — the device side (sleep, activity, vitals); pair the two when a lab result needs lived-in context, e.g. resting HR alongside a thyroid panel.
