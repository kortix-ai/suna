Audit events are never lost, and stuck session starts stop retrying

Audit events are never lost under load, stuck session starts stop retrying forever, and the app is faster.

## Fixed

- Audit events that hit database lock contention are retried with backoff instead of being dropped.
- A session start whose repository clone fails now stops after its retry limit instead of retrying forever.

## Improved

- Faster page loads and API responses: cached git reads, fewer browser preflight requests, fewer repeated queries, and smaller payloads.

