---
recorded: 2026-09-26T15:58:15Z
incident_date: 2026-09-10
---
# Multi-step self-host maintenance run over SSM needs an explicit config dir and a completion marker

**Rule:** do not assume an `aws ssm start-session` shell supplies a normal
interactive environment. The self-host CLI resolves its config root from
`KORTIX_SELF_HOST_CONFIG_DIR` (falling back to `homedir()/.config/kortix/self-host`)
— set it explicitly when driving `kortix self-host` commands non-interactively
over SSM against an existing installation, rather than relying on an assumed
`$HOME`. Execute multi-step maintenance from a file or `bash -c`, never by
piping the whole program into the same stdin a child command can also read.
Require an explicit completion marker and an independent state check after
any update; `exit 0` alone does not prove every step ran.

**Trigger surface:** driving `kortix self-host` maintenance (update, restart,
multi-step repair) over AWS Systems Manager Session Manager instead of an
interactive SSH shell.

**Incident:** a v0.13.13-era self-host CLI update over SSM stopped with
`HOME: unbound variable` before the config-dir override existed in its current
form. A maintenance wrapper piping its program through the session's stdin
then reported exit `0` without reaching its final verification marker,
because the child commands it invoked consumed part of the same stdin stream.

**Enforcement:** none automated. Note: the current self-host default posture
has shifted since this incident — every instance runs an in-compose
`kortix-updater` service that applies daily zero-downtime updates
automatically (`auto_update = "on"` by default; see `self-host/README.md`),
so manual `kortix self-host update` over SSM is now an occasional/ad hoc
operation rather than the primary update path. The completion-marker and
config-dir discipline above still applies to any manual SSM-driven maintenance.
