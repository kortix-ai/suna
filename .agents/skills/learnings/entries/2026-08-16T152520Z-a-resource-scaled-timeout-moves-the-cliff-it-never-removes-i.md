---
recorded: 2026-08-16T15:25:20Z
incident_date: 2026-08-16
commit: a0a02f6c9b
---
# A resource-scaled timeout moves the cliff, it never removes it

**When:** sizing any timeout whose budget you are tempted to scale by how big
the work is — prompt bytes, file size, row count, payload length.

The LLM gateway gave a new upstream stream a first-byte budget of
`30_000 + ceil((requestBytes - 64KiB) / 1MiB) * 15_000`, capped at `120_000`.
Four size steps land on `90_000` exactly, so every request body between
3,211,776 and 4,259,840 bytes got a 90-second budget and then died with
`upstream stream probe timeout exceeded (90000ms with no bytes)` on a
completely healthy upstream. Users saw a Claude Fable 5 turn fail identically
on every retry once an analysis step pushed the context past ~3 MiB.

The scaling was the bug, not an insufficient constant. Growing the context
raises the budget linearly but raises the model's prefill + thinking time by
more, so the cliff is reachable at every size — it just relocates. **Scale the
budget and you have chosen which inputs fail, not whether they fail.**

Three rules:

- **A slow dependency is not a broken one.** Reserve timeouts for detecting
  *death*. Where "slow" and "dead" are locally indistinguishable — which is
  always, for a model that is prefilling — the deadline must pick a
  *degradation*, not a failure. Here it became a COMMIT point: the stream is
  handed to the relay, which sends headers and heartbeats while the model
  works. Failing over is what silently downgraded users to a fallback model.
- **A timeout you cannot observe from the outside will fire on healthy work.**
  The transport emitted nothing for the AI SDK's `start` / `start-step` parts,
  so a live prefill was byte-identical to a dead socket. One keep-alive byte at
  stream open is what separates them.
- **Check the edge before raising any budget.** Nothing is written downstream
  while a pre-header probe runs, and the live `kortix.com` zone reports
  `proxy_read_timeout = 125` with `editable: false` (Free plan). Raising the
  probe past ~125s cannot work — Cloudflare 524s first. Measured, not assumed:
  `GET /zones/$ZONE/settings/proxy_read_timeout`.

**Enforcement:** `streaming.test.ts` sweeps request sizes 0–16 MiB and asserts
the resolver returns one constant, so no size can reproduce 90,000 again.
**Dead-telemetry corollary:** when a failure stops being reachable, delete the
metric that counted it. `kortix.probe_timeout` was left pinned to false on
every span — a dashboard built on it looks healthy by construction.
*Incident:* PR #6473, merged `7e8a56badaef80374a189e0e427a08eb06b44697`.
