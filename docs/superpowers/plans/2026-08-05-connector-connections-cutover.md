# Connector and connection cutover plan

1. Record baseline counts and current report status.
2. Add failing contract tests for terminology, CLI routing, help, manifest byte
   preservation, conflict retry, provider creation, display defects, identifier
   resolution, and marketplace install sessions.
3. Collapse connector commands and rename the CLI runtime modules.
4. Rename the connector SDK package and published surface.
5. Rename the API namespace, modules, runtime flags, and MCP identity.
6. Add a forward database migration and update the Drizzle schema.
7. Fix the remaining report defects and documentation drift.
8. Replace the stale shell smoke with an exhaustive command matrix.
9. Run local unit, type, integration, and real agent-token black-box gates.
10. Push, open, merge, deploy, prove the deployed SHA, and rerun the matrix on
    Dev.
