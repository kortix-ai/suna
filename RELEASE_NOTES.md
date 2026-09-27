Reliable image builds, and session oversight that turns off everywhere

Sandbox image builds keep working under the snapshot quota, and turning off session oversight takes effect everywhere at once.

## Fixed

- Snapshot cleanup now removes images left behind by deleted App deployments, so new sandbox images keep building instead of hitting the provider quota.
- Turning off session oversight takes effect immediately on every server. Admins can no longer open a member's private session for a few seconds afterwards.

## Improved

- Gateway request logs split latency into admission time and upstream wait.
- The Settings panel and icon pickers load on demand, so the app opens faster.

