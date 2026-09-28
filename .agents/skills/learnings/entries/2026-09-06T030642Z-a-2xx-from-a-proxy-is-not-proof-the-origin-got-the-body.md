---
recorded: 2026-09-06T03:06:42Z
incident_date: 2026-09-04
commit: 3caec60726
---
# A 2xx from a proxy is not proof the origin got the body

**When:** forwarding anything to a sandbox, and any time an inbox row is closed
on a status code. The provider's edge DISCARDS a request body over its size
ceiling; the first attempt returns `502` and the RETRY returns `200` for a
request the runtime never saw. `prompt_async` answers for acceptance, never for
the turn, so the drain closed the row `forwarded` on that 200 and the user's
prompt ceased to exist — no message, no turn, no error, row reporting success.
Measured on a live box: **≤104 KB of body lands, ≥115 KB is dropped**; a 6.1 MB
prompt (two inline JPEGs) left no `prompt_async` line in the OpenCode log at
all. **The rule:** prove delivery by READING THE ARTIFACT BACK, and keep every
request to a box under the chunk budget. A read that FAILS is not proof of
absence — lean toward "landed" there, or a retry runs the user's turn twice.
*Enforcer:* `prompt-landing-proof.test.ts`, `runtime-prompt-file.test.ts`
(chunked appends), `queued-continue-inbox-delivery.test.ts` ("a prompt the
runtime never wrote is not reported as forwarded"). *Open:* the ceiling itself
lives in the external provider edge and can move without notice.
