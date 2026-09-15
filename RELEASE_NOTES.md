Project model access controls, GPT-6 Astra, and a desktop app you can always leave

### New

- **Project-level provider and model access controls.** Owners and admins choose which model providers and which models a project may use, from one model management view that also holds provider links. Kortix managed models sit beside your own providers in the same list, a ChatGPT subscription shows its access beside its credentials, and the picker distinguishes "not shown" from "blocked" so a member sees why a model is unavailable.
- **GPT-6 Astra is in the managed catalog.** Select `kortix/gpt-6-astra` with image input, tools, and the supported reasoning efforts. Routing, prices, capability limits, and sandbox fallbacks are all in step.
- **The desktop app always has a way out.** The shell has no browser toolbar, so a page without an in-app exit was a dead end. Every such page now has Close, the Go menu has Back (Cmd/Ctrl+[) and Home (Cmd/Ctrl+Shift+H), a renderer crash offers Reload or Go Home instead of an empty window, and the Electron route allowlist now matches the web middleware's exactly.

### Improved

- **One noun: project.** The interface said "workspace" while the SDK, CLI, API, routes, manifest, and docs all said "project". Screen copy now says project in every one of the nine languages, each with its own word rather than a find-and-replace. The sandbox `/workspace` directory, the manifest's per-agent `workspace:` boundary, and Slack workspaces keep their names.
- **Create a project in a specific account.** The Switch project menu, already grouped by account, gains a "Create a project in {account}" row for each account where you are an owner or admin, including accounts that have no projects yet. The old global link never said which account it would land in.
- **The SSO and SCIM setup wizards work again.** Picking a provider did nothing, and Back or the step rail snapped you to the first step with a render loop in the console. Both are fixed, and a browser journey now walks every step of both wizards on every deploy.
- **Tunnel file transfers are verified end to end.** Binary files sent through the Computer Tunnel are checked by digest at the destination, an approval for one exact file no longer grants its parent directory, permission decisions are serialized so an approve and a deny cannot both win, and orphaned upload tasks are stopped.

### Fixed

- **The sandbox model proxy asked upstream for compressed responses and could not decode them.** It now requests identity encoding, so a session on a model that answered with zstd no longer fails its first turn.

### Internal

- **Project snapshot config provider v2 (S3).** Sessions can boot from a prebuilt, blob-less snapshot of the project's committed tree with the history hydrated off the boot path, falling back to Git when no snapshot is ready. Every environment gets a private snapshot bucket and the task-role grant; only staging names its bucket, so production sessions keep the Git path until the in-region measurement lands.
- The project-snapshot task role gets `s3:ListBucket`, so a missing object is a 404 and not a denied build, and the grant is gated on a plan-time boolean so `terraform plan` succeeds on a root that creates the bucket in the same apply.
- The deployed release gate's contracts were corrected for previews: marketing stays enabled while the browser gate exercises `/pricing`, App domains are not expected on a sandbox origin, cold Daytona boots get a budget above their measured image builds, encoded-path probes accept the exact auth redirect, and the project submenu is required before a row is selected.
- The connector connection-flow routing change (#7074) was merged and reverted within the same window; it ships no behavior.
