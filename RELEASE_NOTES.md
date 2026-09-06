Billing wallet floor, scoped git push, and an agent-centric Customize

### Billing

- **No account runs on an empty wallet.** Paid per-seat and credit-plan accounts used to keep spending past $0 with no floor; one six-seat account settled $588.81 against a $150 monthly grant with the wallet at $0.00. Every account now stops at the same floor before new work starts.
- **Work that already ran is always recorded.** A settlement that the wallet could not cover used to be refused, which deleted the record of the spend and left "Spent this period" frozen while compute kept running. The ledger now records the overdraft, and the account stays blocked until it is topped up.
- **Wallet alerts agree with the server.** Every wallet alert and billing string in the app now reads the account's billing state, so the sidebar and the project page no longer disagree about whether you are out of credits.
- **Credits have their own tab** in account settings, with the available balance and where it comes from. Plan keeps its own card.

### Git and access

- **Push authority is scoped to who is pushing.** A session credential can push only to its own branch. Pushing other refs and deleting refs are two new permissions, `project.gitops.ref.any` and `project.gitops.ref.delete`, held by the project manager role and grantable to agents from the agent editor, the CLI scope validator and the docs. Before this, any credential that could push at all could rewrite or delete any branch.
- **Deleting a branch checks the person's role**, so a plain push right no longer deletes a colleague's branch.
- **GitHub reconnect is named, not failed.** When a stored GitHub App installation stops minting tokens, the app tells you to reconnect instead of throwing an opaque error.
- **A project always has a manifest.** Provisioning through the API seeds `kortix.yaml` by default, and `kortix ship` refuses to push a project that has none.
- **Signed-in identity is your own.** The app no longer shows an account owner's email as the signed-in identity, and account lookups stay inside the account you are in.

### Customize, agents and settings

- **Customize is built around the agent.** Agents lead the Customize bar, and each agent is a full-page editor with a topic rail: People, Access pages for Skills, Connectors, Secrets and Project actions that reuse the catalog cards and modals, grant editing in place, and a Share button showing who has the agent.
- **Capability tabs live under `/customize/<tab>`.** Old URLs redirect. Review is its own tab on the bar. The per-project config page is retired; its sections live in the settings overlay.
- **Settings is a full-screen shell** with Workspace, Personal and Account groups. Security, Appearance, Notifications and Plan are separate tabs. Personal settings are called Preferences, the account Tokens tab is called API keys, and Mod+, opens the panel.
- **Review center** is a full-width inbox with an inline review page, no modals.
- **A change request is a card** in the turn that produced it, with a status that updates and a URL to share.
- **Admin console** rebuilt on the app shell and the design system.
- **Project home and account hub** extracted and tidied: hero column centred, composer band on the base surface, the workspace name throws confetti for every project and the icon only when you choose one.
- **Smaller fixes:** sidebar active row paints again, info and warning banners are legible, managed repositories no longer read as unmanaged, triggers open in place, the Git repository section is its own settings section, and connector proposals get an `<app>-<random>` slug.

### Docs and support

- **Docs moved to Blume.** `/docs` is rebuilt on a new docs engine with a working favicon, a canonical origin, and no stray files in the published site. The credits guide lives at `/docs/credits`.
- **One support hub.** `/help` merged into `/support`: contact channels, guides, FAQ, account deletion and legal in one place.

### Sessions and runtime

- **Stop stays visible while a response streams**, and the session reports busy for the whole turn.
- **Queued prompts keep their order** and sync after a turn completes. Prompts sent during a live turn are forwarded instead of waiting.
- **Turn failures show the real message** instead of a raw JSON body.
- **File tool rows use the right tense** (wrote, edited, listed) instead of the tool's registry name.
- **The terminal no longer reconnects every 60 seconds.** The PTY connection between the API and the sandbox was cut after a minute of silence; both legs are now kept alive.
- **Connecting a provider refreshes the model picker** without a page reload.
- **Older sandboxes catch up.** Boxes provisioned before the self-updating runtime receive the current daemon, OpenCode and CLI from the control plane, and the daemon re-detects the OpenCode binary after a restart. This revives sessions that went silent after the 2026-08-14 OpenCode message-id rollover.
- **Trigger status is truthful.** Reuse, keyed and pinned trigger fires record `fired` on delivery instead of sitting at `queued` forever, dead-letters are visible, and a re-prompted session runs on the trigger's model.

### CLI and desktop

- **`kortix login` works against dev and staging** again. The web firewall was rejecting the localhost callback.
- **Desktop shows a sign-in dialog** for the dev and staging HTTP Basic gate, with an option to remember the credential on the device.
- **`pnpm worktree nuke` stops on a failed removal** instead of reporting success and orphaning the worktree.

### Reliability

- **Audit reconciliation writes use the isolated audit pool**, so an audit lock convoy cannot starve the gateway's auth queries.
- **Preview environments heal themselves.** Disk is pruned, a failed deploy keeps the last good stack, and the environment is named in words rather than by hostname. The JS pi agent has a stable name on Platinum dev.

### Under the hood

- **`@kortix/sdk` root entry is canonical.** The root, `./react` and `./server` are the real entries; the 20 legacy subpaths remain as shims until the next major.
- **One resolved `next` version** across the workspace (16.3.3), with a test that fails the build if the lockfile ever resolves two. Three consecutive dev deploys had died at boot on `Cannot find module 'next'`.
- **Web tests run isolated**, so a partial module mock cannot leak across files.
- **Production has its own managed-git token**, separate from staging, and the secrets exception list was cleaned.
- Two database migrations: the two git ref permissions (4 catalog rows) and a settlement function that records overdrafts. Neither touches user data at volume.
