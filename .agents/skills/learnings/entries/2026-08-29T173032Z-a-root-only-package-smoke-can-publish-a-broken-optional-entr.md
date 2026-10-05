---
recorded: 2026-08-29T17:30:32Z
commit: 644b370a56
---
# A root-only package smoke can publish a broken optional entry point

- **Incident (2026-08-29, v0.13.7 npm release):** a fresh consumer could import
  `@kortix/sdk` and `@kortix/sdk/server`, but `@kortix/sdk/react` failed after
  installing its documented peers. The React graph reached
  `@kortix/llm-catalog/dist/index.js`, which exported `./enablement` without the
  `.js` extension required by plain Node ESM. Repository typechecks and the
  root-only packed-artifact smoke did not traverse that graph.
- **Rule:** a publish smoke must install every documented optional peer and
  import every public entry point that those peers enable. TypeScript
  `moduleResolution:"Bundler"` does not repair extensionless relative imports
  in emitted Node ESM. Source imports must name the emitted `.js` file.
- **Enforcement:** `packages/sdk/scripts/smoke-install.mjs` installs React and
  TanStack Query, imports `@kortix/sdk/react`, and asserts `useSession` exists.
  The `@kortix/llm-catalog` build runs `tsc-alias --resolve-full-paths` to turn
  its extensionless workspace import into `./enablement.js` after `tsc` emits.
