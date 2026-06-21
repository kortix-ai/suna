Sandboxes auto-stop reliably + deterministic compute billing

## Sandbox lifecycle + compute billing (headline)
- Idle sandboxes now reliably **auto-stop after 15 min of no real activity** on every provider, and compute billing **closes deterministically** the moment a box stops — fixes sandboxes that kept running (and billing) for hours/days after work finished.
- Provider-agnostic reaper (real provider state = source of truth; idleness keyed off real turns), quiesce so an open tab can't resurrect a finished box, Platinum reprovision-on-open, gateway per-session usage attribution, provider lifecycle webhooks (/v1/webhooks/sandbox/*) with the reaper as a zero-config backstop, and a billing-invariant monitor.

## Also in this release
- Executor unified into one CLI/MCP/SDK (#3541, #3549); OpenCode title sync (#3544); compact session digests (#3534); preview env-sync retries (#3538, #3539); revert Bedrock (#3545); credits never render as -0 (#3415); dep bumps.
