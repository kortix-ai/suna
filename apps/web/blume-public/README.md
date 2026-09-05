# Blume's public directory

Astro copies its `publicDir` verbatim into the build output, and Blume's
generated Astro config pointed that at `apps/web/public` — the Next app's
362 MB asset folder (wasm engines, wallpapers, the brand-kit zip). Because the
Blume build is then copied back into `public/docs/`, every run nested another
copy of `public/` inside it: `public/docs/` reached 280 MB and contained
`public/docs/docs/`.

`patches/blume@1.5.3.patch` repoints `publicDir` here so only the assets the
docs site actually serves get copied.

Keep this directory tiny. Anything added here ships inside `public/docs/`.
The logo files are here because `deployment.base` rewrites the configured logo
path to `/docs/…`, so they must resolve under the docs base, not the app root.
