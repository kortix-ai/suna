---
recorded: 2026-09-16T00:48:49Z
incident_date: 2026-09-15
commit: aabf1e1df2
---
# Keep subscription usage separate from API token prices

**When:** serving model rates or aggregating session/turn cost. Give ChatGPT/Codex
subscription routes explicit zero rates. Exclude their historical runtime costs
before applying token estimates or markup. Preserve tokens and paid API costs.
*Incident:* a reported ChatGPT session displayed `$7.91` from inherited OpenAI
API prices. *Enforcers:* SDK turn-cost tests, catalog tests, REST flow `GW-5`,
and browser journey 26 cover subscription-only and mixed sessions.
