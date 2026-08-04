import { postInstall } from 'fumadocs-mdx/next';

// `.source/` (src/lib/source.ts, src/lib/use-cases-source.ts) is generated
// codegen and gitignored (apps/web/.gitignore) — it never travels with a
// commit, so a clean checkout (CI, Vercel) starts with none at all.
//
// `createMDX()` in next.config.ts also regenerates it, but only as an
// un-awaited side effect fired at config-load time: a race against Next's
// own module resolution, and its content-hash cache can skip rewriting a
// `.source/index.ts` left over from an older fumadocs-mdx major version if
// the underlying MDX source files didn't change (only the package did).
// Run codegen here instead — synchronously, before `next build`/`next dev`
// starts — so `.source/` is always present and current-format on a checkout
// that has never run a dev server.
await postInstall();
console.log('[fumadocs-mdx] regenerated .source/');
