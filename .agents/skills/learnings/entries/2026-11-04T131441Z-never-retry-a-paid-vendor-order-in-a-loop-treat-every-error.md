---
recorded: 2026-11-04T13:14:41Z
incident_date: 2026-11-04
---
# Never retry a paid vendor order in a loop; treat every error answer as a possible order

**Rule:** Send a paid order to a vendor once per approval. After any non-2xx answer, list what exists on the vendor side before you send anything again. Never put an order call in a retry loop or a watcher. A loop that waits for stock watches the stock feed and asks the person again when stock appears.

**Trigger surface:** Ordering hardware or any paid resource through a vendor API (Scaleway, Hetzner Robot, OVH, a cloud console), writing a retry, poll or watcher around a create call, or reading a 4xx from a create endpoint as "nothing happened".

**Incident:** 2026-11-04. One bare-metal server was approved, and an agent retried the order every 5 min while the vendor reported no stock. Every attempt answered `400 No server available`, and every attempt still created a server record in `delivering`. The API cannot delete such a record. After 80 attempts the vendor's account quota (80/80) stopped the loop. Nothing billed while the records waited. Each one could have become a monthly server with a setup fee on delivery: about 80 times the approved spend. The orders went to vendor support for cancellation.

**Enforcement:** Platinum `infra/compute-market` (`sendOrder`, PR #2641) refuses a Scaleway order while one of the same name waits in `delivering`, and reports servers created despite an error. `test/order.test.ts` covers both. The Platinum `compute-buying` skill carries it as hard rule 6. None yet for other vendors' order paths.
