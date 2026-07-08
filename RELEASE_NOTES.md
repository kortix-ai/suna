Marketplace imports, groups and custom roles for every plan, and a sandbox that recovers when a build fails

## New

- **Install from the marketplace in one click.** Agents, commands and bundles can now be imported straight into a project. Detail pages show what a bundle actually contains — its files, its capabilities, and what it will be allowed to do — before you install it.
- **Groups and custom roles on every plan.** Previously gated; now available to everyone.
- **Approve or deny agent permission requests from the review center**, and change descriptions render as proper markdown.
- **Answer an agent's permission prompts from the CLI.** A session that stops to ask for approval no longer needs the web app to continue.
- **Connect Slack in one click** with `kortix channels connect`, instead of setting up an app by hand.
- **`kortix login` binds a default project**, and commands that need one recover interactively instead of failing.
- **OAuth1 connectors.** OpenAPI and HTTP connectors can authenticate with OAuth1.
- **Available upgrades are highlighted** in the project view with a recommended badge.

## Improved

- **Projects are configured with `kortix.yaml`.** Existing `kortix.toml` files still work — they are read as the v1 format — and YAML now has full parity: agent scoping, trigger paths, and errors that name the format they came from.
- **Onboarding** moves the skip control into each step's footer.
- **Consistent loading, empty, and error states** across projects, sessions, connectors, agents, members, gateway logs and sandbox templates. Destructive actions — deleting a secret, revoking a gateway key, removing a sandbox template, archiving a project — now confirm first.
- **Bulk actions in the review center** describe what they will actually do.

## Fixed

- **Sandbox builds recover properly when they fail.** "Retry build" rebuilds the right template instead of failing, and "Fix with agent" is no longer offered for infrastructure failures it cannot repair. Superseded sandbox images are also garbage-collected before they can exhaust the image quota and block new builds.
- **Permissions are enforced consistently, and no longer leak.** Project endpoints check the specific permission they need rather than a broad one; sections you cannot read are omitted from responses instead of returned and hidden; members with a read-only role can fire triggers; and the app stops raising permission errors for surfaces you were never shown.
- **Security hardening** from a code scan: fixed a regular-expression denial-of-service, an unsafe temporary file, a time-of-check/time-of-use race, and an unsafe URL opener in the CLI.
- **Setup links render as buttons**, never as a raw URL containing a token.
- **Service-account tokens** are accepted everywhere user tokens are.
- **A sandbox that fails to start is retried** instead of being left in a failed state.
- **An unknown CLI command reports an error** instead of scaffolding a project named after the typo.
- **The model picker updates immediately** after you connect a provider.
- **Renaming a project or session** can no longer be dismissed mid-save.
