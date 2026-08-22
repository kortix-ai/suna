# Connector authentication discovery implementation plan

1. Add pure failing tests for OpenAPI/Swagger and Postman inheritance,
   coverage, redaction, OAuth metadata, compound requirements, and unsupported
   schemes.
2. Implement the pure normalized discovery module and merge/ranking rules.
3. Add failing API tests for preview and create-with-omitted-auth versus explicit
   `none`; wire source loading and guarded endpoint challenge discovery.
4. Add the additive SDK types/function/facade, with RED-watched transport and
   public-surface tests.
5. Update CLI semantics so omitted `--auth-type` auto-detects and help text says
   so.
6. Update the connector form to default to Auto-detect, preview detected auth,
   and retain manual/None overrides. Add pure UI-state regressions.
7. Verify locally with HubSpot's Postman repository plus representative OpenAPI
   bearer, API-key, OAuth 2, and explicit-none fixtures; run API/CLI/web/SDK
   gates and real HTTP/UI assertions.
8. Push, open a PR, merge after required checks, follow Deploy Dev to the exact
   SHA, and repeat the black-box HubSpot and UI assertions on dev.

