---
recorded: 2026-09-28T22:23:55Z
incident_date: 2026-09-28
---
# Round a feed price before comparing it to a cap

**Rule:** Round a per-token price to a fixed number of decimals before you compare it to
`max_price` or any other cap. A float conversion adds noise above the exact value.
Gate a compliance claim (ZDR, data location) on the routing facts, never on whether a
price quote exists.

**Trigger surface:** `managed-pricing-routes.ts`, `MANAGED_MODELS` pricing, or any UI that
derives a ZDR or US-location claim from quote data.

**Incident:** From 2026-09-26 (`5a93f4f3e4`) to 2026-09-28 (#8022), the managed model list
on dev, staging, and prod had two defects. It hid "Zero data retention · US-based
providers" and labelled every price "OpenRouter · <endpoint tag>". The OpenRouter feed
lists Fireworks US at `0.0000033` per token, and `0.0000033 * 1e6 = 3.3000000000000003`.
That is greater than Kimi K3's `max_price` 3.3, so the refresh dropped Kimi K3's only
route. The group gate needed every model to have a route, so the claim disappeared for
all managed models. Routing itself did not change.

**Enforcement:** `managed-pricing-routes.test.ts` → "keeps an endpoint whose live price
equals the gateway cap". `MANAGED_ENDPOINT_PROVIDERS` is typed by
`VERIFIED_US_MANAGED_ENDPOINTS`, so an unnamed endpoint fails to compile.
