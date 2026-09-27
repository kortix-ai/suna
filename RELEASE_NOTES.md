Sessions ride through outages

Sessions keep working through model and runtime outages, turns start faster, and sessions open instantly.

## Improved

- Opening a session shows its saved history immediately from cache while the live transcript loads, in one request instead of several.
- Turns start faster: configuration, model catalog and ingress checks run in parallel.
- Sessions retry transient model errors inside the turn and continue through short provider outages instead of stopping.
- A session whose runtime was lost resumes automatically when it was running unattended.
- The sandbox model catalog stays current across boot, wake, restart and every turn.
- Streaming responses never forward a partial event line; a stream cut before the first byte is retried, and a later cut ends with an explicit error.
- The `kortixt` terminal desk adds cloud sessions, port forwarding, a Links panel and a self-updating launcher.

## Fixed

- Turns were sometimes marked abandoned while still running.
- Transcript requests could return 401 during a session.
- Stopped sandboxes could stay running after their session ended.
- Orphan cleanup only stops sandboxes that this deployment's database owns.

