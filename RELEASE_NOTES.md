Wedged sandboxes are reclaimed, and database contention no longer looks like a server fault

### Fixed

- **Sandboxes cannot outlive their work.** A session turn now has an absolute ceiling as well as a renewable one. Renewal asks whether a turn is still running, and a wedged turn answers "yes" forever, so a turn record past the ceiling is now settled instead of being renewed indefinitely and its sandbox is reclaimed. This one cause sat behind several classes of server error.
- **Fewer server errors when the database is busy.** Connection-class and contention failures are now recognised as the temporary conditions they are and retried, instead of being reported as server faults.
- **Errors say what actually went wrong.** A failure now carries its real cause rather than the message of whatever wrapped it, and how serious it is follows that cause. Ordinary customer state no longer looks like a platform failure, so real failures stop being buried.
- **A large unused database index is gone**, removing its write cost from every audit record. It was 8.6 GB and had served no read in two and a half months.
- **One subscription dialog, in the right place.** The upgrade dialog now renders above the deepest panel that opened it, so its controls stay reachable and screen readers can see it. Escape closes it and leaves account settings open.
- Ordered lists size their gutter to the widest marker, so long lists no longer clip their numbers.
- Desktop: the Back control sits correctly on sign-in screens.

### New

- Desktop asks which Kortix instance to use on first launch.

### Internal

- The test harness no longer loses a whole browser shard when a dev-server cache restore fails, and a finished test run now exits instead of hanging when something leaves a connection open. Both had turned passing runs into failed ones.
