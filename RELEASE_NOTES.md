Deploys without connection errors, and a faster app

Deploys no longer cause a burst of errors, and the app is faster.

## Fixed

- A production deploy no longer briefly runs the database out of connections. Session start, stop and model listing stay available while a new version rolls out.

## Improved

- The connector catalog resolves connectors concurrently.
- Avatars render from generated paths instead of loading the full icon set.
- Branch listings for views are faster, and Composio auth configuration is served from cache while it refreshes.

