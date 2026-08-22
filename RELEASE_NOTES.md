Bound database connections and isolated audit writes

Fixes production PostgreSQL SQLSTATE 53300 connection exhaustion. Bounds every API database pool for the maximum rolling fleet, isolates slow audit writers on a dedicated two-connection pool per task, adds request-storm controls, and adds release-tree capacity regression coverage.
