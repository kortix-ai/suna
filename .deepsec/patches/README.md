# Audited scanner matchers

`deepsec@2.1.2.patch` removes upstream's embedded minimatch 10.2.5 / glob
11.1.0 bundle and imports the workspace's audited minimatch 11.0.1 / glob
14.0.2 instead. Updating only the lockfile leaves the embedded code running.
The patch is intentionally mostly deletion; regenerate it when updating deepsec.
The removed span includes glob's private supporting modules, which have no users
outside that span. Scanner discovery uses `glob`, `globSync`, `escape` and
`minimatch`, all imported from the replacements.

Overrides are scoped to the actual named consumers. Sandbox 2.2.0 is the first
2.x release using zod 4, avoiding the vulnerable zod 3 tree under the unchanged
audit policy. No cloud sandbox is created by the regression suite.

Run `bun test scripts/independent-glob-security.test.mjs` from the repository root
after independently installing `.deepsec` with pnpm 9.15.4 and the daemon with Bun
1.4.3. `SCANNER_MANIFEST` and `DAEMON_MANIFEST` can point at baseline package
manifests to reproduce the amplification regression without modifying installs.
