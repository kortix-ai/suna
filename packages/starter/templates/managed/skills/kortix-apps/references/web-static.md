# Static web Apps

A static App is files. Kortix stores them and serves them itself: no machine,
no cold start, no compute bill, instant rollback. It is the default for every
UI, including one that uses a `convex` App for its data.

## Select the source

| Source | Deploy |
| --- | --- |
| HTML, CSS, JavaScript | `--type static` |
| Prebuilt Vite or React `dist/` | deploy `dist/ --type static --spa` |
| Vite or React source | build it here (`npm run build`), then deploy `dist/ --type static --spa` |
| Next.js static export | set `output: 'export'`, build, then deploy `out/ --type static --spa` |

Before building, inspect `package.json` and the lockfile. Run the declared
`build` script with the repository's package manager. Do not assume `pnpm`
when the project uses npm, Yarn, or Bun.

```bash
npm run build
kortix apps deploy ./dist --slug storefront --name Storefront --type static --spa
```

## Build here, deploy the output

Build here, then deploy the output directory itself as the path
(`kortix apps deploy ./dist`):

- The CLI reads `.gitignore`, `.dockerignore`, and `.kortixignore` only from
  the directory it uploads. A repository `.gitignore` that lists `dist/` does
  not hide `./dist` when `./dist` is the path.
- The CLI never uploads `.env*` files. A build-time value (`VITE_*` or
  `NEXT_PUBLIC_*` in `.env.production`) reaches the App only through a build
  you ran here, before the deploy. An App that uses a `convex` App needs no
  build-time URL: `kortixBinding` reads its own origin (bindings.md).
- Keep `dist/` and `out/` in the repository's `.gitignore`. Committed build
  output bloats the repository every session clones (`kortix validate`
  warns).
- A static App holds at most 20,000 files of at most 50 MiB each. A larger
  site fails with `invalid_site`.
- A static publish never serves `.git/`, `.env*` or `.DS_Store`, at any
  depth, even when an SDK or API upload contains them. The `site_published`
  log line counts what it left out.
- A symlink in the upload that resolves outside it fails the deploy
  (`escapes the build context`). Links inside the upload are kept.
- A static App runs no server, so it ignores `env` and `secrets`: a deploy
  that sets them records an `environment_ignored` event.

Package managers now block install scripts by default and Vite then fails on
esbuild: with npm 12 run `npm install-scripts approve esbuild` in each
package directory (it records `allowScripts` in `package.json`); with pnpm 11
add `allowBuilds: { esbuild: true }` to `pnpm-workspace.yaml`.

## Caching

HTML and every other file revalidate on each request (ETag, `304`). Build
output with a content hash in its name is immutable for a year:
`_next/static/`, and files under `assets/` or `static/js|css|media/` named
like `index-D8j1YYcB.js`. Never overwrite such a file in place; let the
bundler rename it. A public App's immutable files are also cached at the
Kortix edge. After a switch to private or a delete, edge copies stay
reachable by exact URL for up to 1 hour. A directory URL without its slash
(`/docs`) redirects `308` to `/docs/`, so relative links in
`docs/index.html` resolve. Files over 4 MiB are served uncompressed and
support `Range` requests.

## Verify

1. `kortix apps show <slug> --json`: `hosting_type` is `static` and
   `capabilities` lists `static`.
2. Read the stable URL from `app.url`. Fetch it. For a private App, create an
   authenticated link with `kortix apps access-link <slug> --json`, follow
   redirects, and retain the response cookie. Assert status `200`, the
   expected body marker, and the content type.
3. Discover an actual `src` or stylesheet `href` in the returned HTML. Resolve
   it against the stable App URL and fetch that hashed JavaScript or CSS
   asset. Assert status `200` and its content type. Do not guess the hashed
   filename.
4. For an SPA, fetch a client route. Confirm it returns the same root marker
   and hashed entry asset as `/`.
5. For a non-public App, fetch the stable URL without credentials and confirm
   it returns `401` before testing authorized access.

A static App has no runtime: `start` and `stop` answer
`409 static_app_no_runtime`, `kortix apps ls` prints `static` as its state,
and it serves while it has an active deployment. Delete it to take it
offline. A rollback switches traffic at once.

## Diagnose

`kortix apps logs <slug> <deployment-id>` prints the deployment's events, one
per line, for example `<time> kortix  [site_published] Published 12 files (12
new, 0 unchanged)`. A failed deploy names its cause in the deployment's
`error_code` (`invalid_site` for a missing root, an empty root, too many
files, or a file that is too large).
