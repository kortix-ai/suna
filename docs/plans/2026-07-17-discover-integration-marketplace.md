# Discover integration marketplace implementation plan

1. RED: add API tests for integrations.sh paging/search/detail normalization and for
   exact Pipedream OAuth filtering.
2. GREEN: add the cached integrations.sh catalogue client and authenticated executor
   list/detail routes.
3. RED: add SDK transport/type tests for list/detail and OAuth attribution.
4. GREEN: expose the additive SDK functions and types through the existing connector
   surface and facade exports.
5. RED: add web catalogue contract tests for Discover naming, direct-first ordering,
   explicit `Pipedream OAuth` labelling, Slack exclusion, and variant actions.
6. GREEN: replace the Easy Connect catalogue with the unified Discover grid and
   variant modal while retaining Channels and Custom.
7. Verify focused tests, full API/web checks, all mandatory SDK gates, real upstream
   data, local authenticated HTTP, and Chromium behavior at desktop and mobile widths.
8. Push a scoped PR, merge to `main`, follow Deploy Dev to the merged SHA, and repeat
   the user-visible checks on dev.
