Reliable scheduled triggers

**Scheduled triggers (crons) are now resilient — no single trigger can hold up the rest.**

- A slow or stuck trigger fire (e.g. resuming a sandbox) no longer blocks the scheduler: each fire is time-bounded and isolated, so one trigger can fail and retry while every other trigger keeps firing on schedule.
- The scheduler self-heals — a stalled sweep is automatically reclaimed, so automations can't silently stop.
- Hardened background-worker leadership so an API-only node can never sit on the scheduler lease without running it.
- Added a stall watchdog + health signal so a frozen scheduler is surfaced immediately instead of going unnoticed.
