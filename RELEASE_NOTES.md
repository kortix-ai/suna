Fix fleet-wide 30s API timeouts (DB connection-pool starvation)

Resolves waves of Request timed out after 30s across unrelated endpoints (change-requests, sandbox-health, secrets, iam, sessions). Root cause (confirmed against live prod via pg_stat_statements + CloudWatch): the postgres.js client had no pool/timeout config (max:10/replica, ~20 connections fleet-wide vs a 240 server) and no acquire timeout, so occasional very-slow queries pinned connections up to the 2-min server limit and other requests queued until the 30s client abort.

- DB client: max 10->15, connect_timeout 10s, idle_timeout 30s, max_lifetime, statement_timeout 25s (below the 30s client abort so stuck queries free their connection and the queue drains). Proven against the real DB.
- Web: collapse 7 per-action IAM effective probes into one batch call.
- Infra: opt-in ALBRequestCountPerTarget autoscaling.
- Request-deadline middleware shipped inert (default off) pending long-op exemption analysis.
