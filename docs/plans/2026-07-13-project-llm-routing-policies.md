# Project LLM gateway routing policies implementation plan

1. Add failing SDK tests for the routing-policy REST methods, project facade,
   React Query invalidation, and additive public exports.
2. Add failing API pure tests for validation, inheritance, exact-rule
   precedence, vision routing, disabled fallback, and route preview metadata.
3. Add the database migration/schema and repository/service implementation.
4. Register authenticated GET/PUT/DELETE/preview project routes and connect the
   control-plane resolver to cached project policy state with write invalidation.
5. Implement the typed SDK functions, project facade, React hook, documentation,
   and accepted additive export snapshots.
6. Add the `Routing` tab and compose default selectors, ordered-chain editor,
   exact override modal/disclosures, reset confirmation, and route preview.
7. Run focused RED/GREEN loops, full SDK gates, API/DB/web gates, and migration
   bootstrap checks.
8. Start the isolated stack and execute authenticated HTTP, real browser, and
   real gateway forced-fallback E2E with cleanup.
9. Commit, push, open and merge the PR; follow Deploy Dev and repeat the live
   API/UI/gateway proof without touching staging or production.

