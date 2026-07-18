# Discover integration marketplace implementation plan

1. RED: add API tests for integrations.sh paging/search/detail normalization and for
   exact Pipedream OAuth filtering.
2. GREEN: add the cached integrations.sh catalogue client and authenticated executor
   list/detail routes.
3. RED: add SDK transport/type tests for list/detail and OAuth attribution.
4. GREEN: expose the additive SDK functions and types through the existing connector
   surface and facade exports.
5. RED: add experimental-contract and web tests for off-by-default visibility,
   preserving Easy Connect, direct-first ordering, explicit `Pipedream OAuth`
   labelling, Slack exclusion, and variant actions.
6. GREEN: add Discover as a separately mounted sibling of Easy Connect. Gate it on
   `connectors_api_discover`, keep Easy Connect's default and implementation intact,
   and avoid mislabelling domain cards as MCP-only.
7. Verify focused tests, full API/web checks, all mandatory SDK gates, real upstream
   data, local authenticated HTTP, and Chromium behavior at desktop and mobile widths.
8. Push a scoped PR, merge to `main`, follow Deploy Dev to the merged SHA, and repeat
   the user-visible checks on dev.
