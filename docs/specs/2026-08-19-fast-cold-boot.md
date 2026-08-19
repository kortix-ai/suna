# Platinum create-time secret arming

Status: enabled on dev behind `KORTIX_FAST_COLD_BOOT_ENABLED`.

## Problem

Platinum used two sequential API operations for every session:

1. Create the sandbox.
2. Attach and arm the network-boundary secrets.

The second operation cost 18,261 ms at p50 across five measured boots.
The sandbox could not become active during this operation.

## Design

When `KORTIX_FAST_COLD_BOOT_ENABLED=true`, the API prepares the secret replicas first.
It includes their IDs in Platinum's sandbox-create request.
Platinum creates the VM and arms its network boundary in the same operation.

The API still waits for the returned secret state to become `armed`.
It deletes the sandbox when arming fails.
Raw secret values never enter the sandbox.

The flag does not change the sandbox image.
It does not create or retain a sandbox pool.
It does not change Daytona or E2B behavior.

Set `KORTIX_FAST_COLD_BOOT_ENABLED=false` and redeploy to restore post-create arming.
This rollback does not require a database migration or sandbox cleanup.

## Local A/B result

Both groups used the same API, Platinum account, project, standard image code, and Cloudflare tunnel.
Each group contains five successful boots from 2026-08-19.

| Milestone | Flag off p50 | Flag on p50 | Change |
|---|---:|---:|---:|
| Network secret phase | 18,261 ms | 0 ms | -18,261 ms |
| Sandbox row active | 36,183 ms | 21,315 ms | -14,868 ms |
| Provider create | 3,096 ms | 3,735 ms | +639 ms |

The row-active result includes normal provider and API variance.
The measured p50 improvement is 41.1%.

The two groups used different per-project cache states after the first group triggered a warm-image bake.
Runtime-ready time is therefore not a valid direct A/B metric in this sample.
The host-side secret phase and row-active milestones remain directly measured.

## Next bottleneck

The flag-on cold-image sample measured these p50 guest stages:

| Stage | p50 |
|---|---:|
| Repository materialized | 12,265 ms |
| OpenCode answering | 5,259 ms |
| Configuration dependencies | 553 ms |

Git clone is the next isolated optimization target.
