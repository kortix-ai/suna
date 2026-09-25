---
recorded: 2026-09-16T19:31:03Z
incident_date: 2026-09-16
commit: abde201e9d
---
# Keep subscription picker prices distinct from session charges

**When:** publishing ChatGPT/Codex models to the picker. Retain the published
model price fields. Zeroing catalog rates makes the picker call a paid ChatGPT
subscription “Free.” Keep subscription session cost at `$0.00` in SDK accounting;
the picker rates are reference prices, not an extra per-token subscription bill.
*Correction to the 2026-09-15 entry below:* zero catalog rates misstate the
subscription price. *Enforcers:* catalog model tests, `GW-5`, and browser journey 26.
