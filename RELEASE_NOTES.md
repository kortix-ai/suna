A reliable admin accounts list and faster connector resolution

The admin accounts list loads reliably, and sessions resolve their connectors faster.

## Fixed

- The admin console's account list uses an index and no longer times out. A slow query now returns a clear error instead of raw database text.

## Improved

- Sessions resolve their connectors in one batched lookup, and Composio discovery serves cached results while it refreshes.

