---
recorded: 2026-08-25T20:45:28Z
commit: f23d422285
---
# Regenerating a CA on every listener restart breaks trust and the CI clock

*Incident (2026-08-25):* the daemon egress shim minted a fresh RSA CA on every
rule change (`syncEgressShim` restart). Shells that had sourced the previous
trust bundle would fail TLS until re-sourced, and node-forge's keygen (1-4 s)
made the packages CI lane time out on the restart tests.

**Rules.** One CA per daemon process (`sessionCa` in `egress-shim/index.ts`),
reused across restarts; tests reset it via `__resetEgressShimForTests`.
Timing tests keep at least a 5× margin between the paced event and the budget
they assert (relay-transport "measures SILENCE").
