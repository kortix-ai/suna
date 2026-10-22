---
recorded: 2026-10-03T20:45:33Z
incident_date: 2026-10-03
---
# Reuse an existing Docker network without sharing Supabase data

**Rule:** When Docker exhausts its address pools, reuse an existing local network with `supabase --network-id`. Keep the new project's container names, ports, volumes, database, and auth state separate. Do not delete another session's networks or containers.

**Trigger surface:** Creating an isolated local Supabase worktree on a machine with many Docker networks.

**Incident:** On 2026-10-03, isolated worktree creation failed with `LegacyNetworkCreateError`: all predefined address pools were fully subnetted. Starting only PostgreSQL on an existing network succeeded. Starting the full stack before migrations then failed because the `kortix` schema did not exist. The recovery applied the existing prerequisite and migration commands before starting the full stack. The isolated auth health endpoint returned `200`. Other worktrees remained running.

**Enforcement:** None yet: the worktree CLI needs an explicit network-selection option. The e2e pilot runbook records the recovery order. Its live session journey requires isolated database mode and funds the synthetic account in that database before using the UI.
