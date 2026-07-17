# Postman connector implementation plan

1. Add RED tests for Collection v2.1 normalization, request execution, source
   classification, `.postman/api` relation parsing, manifest validation, CRUD
   round-tripping, SDK typing, and CLI argument acceptance.
2. Implement a dependency-injected Postman source resolver with strict fetch
   limits and GitHub/Postman URL adapters.
3. Implement Collection v2.0/v2.1 normalization and the `postman` execution
   binding, including template substitution, static headers/query values, body
   handling, warnings, risk, and schema inference.
4. Wire `provider: postman` through manifest schema, API sync/materialization,
   gateway/database shapes, SDK public types/snapshots, CLI/MCP surfaces, web
   form, JSON schemas, and documentation.
5. Add integration fixtures for a direct collection and a multi-definition
   `.postman/api` repository. Run focused tests and all affected package gates.
6. Run the local stack and prove API, CLI, UI, executor call behavior, the live
   HubSpot repository, and a raw HubSpot collection with real requests.
7. Commit, push, open and merge the PR, monitor required checks, verify Deploy
   Dev contains the merge SHA, then repeat the customer-visible proof on dev.

